import {
  SimulationPhase,
  type CommandHandler,
  type SimulationSystem,
  type SimulationView,
  type SystemUpdate,
} from "../contracts.js";
import { Resources } from "../resources.js";
import { type JsonObject } from "../types.js";
import { payloadField } from "./cohorts.js";
import {
  KNOWLEDGE_LAYER_ID,
  RESEARCH_SYSTEM_ID,
  TECHNICAL_DEBT_LAYER_ID,
  TECHNICAL_DEBT_SYSTEM_ID,
} from "./ids.js";
import type { SimulationLayer } from "./layer.js";

export {
  TECHNICAL_DEBT_LAYER_ID,
  TECHNICAL_DEBT_SYSTEM_ID,
} from "./ids.js";

export interface DebtCategoryCohort extends JsonObject {
  readonly id: string;
  readonly interestPermille: number;
  readonly maintenanceEfficiencyPermille: number;
}

export interface TechnicalDebtState extends JsonObject {
  readonly categories: readonly DebtCategoryCohort[];
  readonly retired: number;
  readonly interestIncidents: number;
  readonly peakDebt: number;
  readonly principalByCategory: Readonly<Record<string, number>>;
  readonly lastRemediation?: DebtRemediation;
  readonly manualPaydown?: { readonly categoryId: string; readonly amount: number } | null;
  readonly lastManualPaydown?: {
    readonly tick: number;
    readonly categoryId: string;
    readonly requested: number;
    readonly retired: number;
    readonly capacitySpent: number;
    readonly moneySpent: number;
  };
}

export interface DebtRemediation extends JsonObject {
  readonly availableCapacity: number;
  readonly capacitySpent: number;
  readonly maintainable: number;
  readonly affordableDebt: number;
  readonly retired: number;
  readonly debtBefore: number;
}

export interface TechnicalDebtLayerOptions {
  readonly categories: readonly DebtCategoryCohort[];
  readonly debtPerMaintenanceCapacity: number;
  readonly moneyPerDebtRetired: number;
  readonly debtPerInterestBug: number;
}

class TechnicalDebtSystem
  implements SimulationSystem<TechnicalDebtState>
{
  public readonly id = TECHNICAL_DEBT_SYSTEM_ID;
  public readonly pipeline = TECHNICAL_DEBT_LAYER_ID;
  public readonly phase = SimulationPhase.Maintenance;
  public readonly dependsOn = [RESEARCH_SYSTEM_ID];
  public readonly reads = [
    Resources.TechnicalDebt,
    Resources.MaintenanceCapacity,
    Resources.Money,
    Resources.Knowledge,
  ];
  public readonly writes = [
    Resources.TechnicalDebt,
    Resources.MaintenanceCapacity,
    Resources.Money,
    Resources.Bugs,
    Resources.Insight,
  ];
  public readonly stateReads = [];
  public readonly eventReads = [
    "source.batch-generated",
    "build.completed",
    "build.failed",
    "research.completed",
  ];
  public readonly emits = ["debt.maintained", "debt.interest-accrued", "debt.manual-paydown"];

  public constructor(private readonly options: TechnicalDebtLayerOptions) {}

  public initialState(): TechnicalDebtState {
    return {
      categories: this.options.categories,
      retired: 0,
      interestIncidents: 0,
      peakDebt: 0,
      principalByCategory: Object.fromEntries(
        this.options.categories.map((category) => [category.id, 0]),
      ),
    };
  }

  public run(view: SimulationView): SystemUpdate<TechnicalDebtState> {
    const state = view.getSystemState<TechnicalDebtState>(this.id);
    const principalByCategory = { ...state.principalByCategory };
    for (const event of view.events) {
      const categoryId = payloadField(event.payload, "debtCategoryId");
      const amount = payloadField(event.payload, "debt");
      if (
        typeof categoryId === "string" &&
        typeof amount === "number" &&
        Number.isSafeInteger(amount) &&
        amount > 0
      ) {
        principalByCategory[categoryId] =
          (principalByCategory[categoryId] ?? 0) + amount;
      }
    }
    const debt = view.resources.get(Resources.TechnicalDebt);
    let categorizedDebt = Object.values(principalByCategory).reduce(
      (total, principal) => total + principal,
      0,
    );
    if (categorizedDebt > debt) {
      const reconciled = this.retireDebt(
        principalByCategory,
        state.categories,
        categorizedDebt - debt,
      );
      for (const key of Object.keys(principalByCategory)) {
        principalByCategory[key] = reconciled[key] ?? 0;
      }
      categorizedDebt = debt;
    }
    const uncategorizedDebt = Math.max(0, debt - categorizedDebt);
    const fallbackCategory = state.categories[0];
    if (uncategorizedDebt > 0 && fallbackCategory !== undefined) {
      principalByCategory[fallbackCategory.id] =
        (principalByCategory[fallbackCategory.id] ?? 0) +
        uncategorizedDebt;
    }
    const maintenanceCapacity = view.resources.get(
      Resources.MaintenanceCapacity,
    );
    const affordableDebt =
      this.options.moneyPerDebtRetired === 0
        ? debt
        : Math.floor(
            view.resources.get(Resources.Money) /
              this.options.moneyPerDebtRetired,
          );
    const knowledgeEfficiency = Math.min(
      2_000,
      1_000 + view.resources.get(Resources.Knowledge) * 5,
    );
    const manual = state.manualPaydown;
    const manualCategory = state.categories.find((category) => category.id === manual?.categoryId);
    const manualPotential = manualCategory === undefined ? 0 : Math.floor(
      (maintenanceCapacity * this.options.debtPerMaintenanceCapacity *
        knowledgeEfficiency * manualCategory.maintenanceEfficiencyPermille) / 1_000_000,
    );
    const manualRetired = manual === null || manual === undefined ? 0 : Math.min(
      manual.amount, principalByCategory[manual.categoryId] ?? 0,
      affordableDebt, manualPotential,
    );
    const manualCapacitySpent = manualRetired === 0 || manualCategory === undefined ? 0 :
      Math.min(maintenanceCapacity, Math.ceil(
        (manualRetired * 1_000_000) /
        (this.options.debtPerMaintenanceCapacity *
          knowledgeEfficiency * manualCategory.maintenanceEfficiencyPermille),
      ));
    const afterManual = { ...principalByCategory };
    if (manual !== null && manual !== undefined) {
      afterManual[manual.categoryId] = (afterManual[manual.categoryId] ?? 0) - manualRetired;
    }
    const automaticCapacity = maintenanceCapacity - manualCapacitySpent;
    const automaticDebt = debt - manualRetired;
    const automaticAffordable = affordableDebt - manualRetired;
    const trackedPrincipal = Object.values(afterManual).reduce(
      (total, principal) => total + principal,
      0,
    );
    const averageMaintenanceEfficiency =
      trackedPrincipal === 0
        ? 1_000
        : Math.floor(
            state.categories.reduce(
              (total, category) =>
                total +
                (afterManual[category.id] ?? 0) *
                  category.maintenanceEfficiencyPermille,
              0,
            ) / trackedPrincipal,
          );
    const maintainable = Math.floor(
      (automaticCapacity *
        this.options.debtPerMaintenanceCapacity *
        knowledgeEfficiency *
        averageMaintenanceEfficiency) /
        1_000_000,
    );
    const retired = Math.min(automaticDebt, maintainable, automaticAffordable);
    const capacitySpent =
      retired === 0
        ? 0
        : Math.min(
            automaticCapacity,
            Math.ceil(
              (retired * 1_000) /
                (this.options.debtPerMaintenanceCapacity *
                  Math.max(
                    1,
                    Math.floor(
                      (knowledgeEfficiency * averageMaintenanceEfficiency) /
                        1_000,
                    ),
                  )),
            ),
          );
    const totalRetired = manualRetired + retired;
    const remainingDebt = debt - totalRetired;
    const remainingPrincipalByCategory = this.retireDebt(
      afterManual,
      state.categories,
      retired,
    );
    const interestPressure = state.categories.reduce(
      (total, category) =>
        total +
        Math.floor(
          ((remainingPrincipalByCategory[category.id] ?? 0) *
            category.interestPermille) /
            1_000,
        ),
      0,
    );
    const interestBugs = Math.floor(
      interestPressure / this.options.debtPerInterestBug,
    );
    const events = [];
    if (totalRetired > 0) {
      events.push({
        type: "debt.maintained",
        payload: { retired: totalRetired, remainingDebt },
      });
    }
    if (manual !== null && manual !== undefined) {
      events.push({
        type: "debt.manual-paydown",
        payload: { categoryId: manual.categoryId, requested: manual.amount,
          retired: manualRetired, capacitySpent: manualCapacitySpent,
          moneySpent: manualRetired * this.options.moneyPerDebtRetired },
      });
    }
    if (interestBugs > 0) {
      events.push({
        type: "debt.interest-accrued",
        payload: { bugs: interestBugs, remainingDebt },
      });
    }

    return {
      resources: [
        {
          resource: Resources.TechnicalDebt,
          amount: -totalRetired,
          reason: "Maintenance work",
        },
        {
          resource: Resources.MaintenanceCapacity,
          amount: -(manualCapacitySpent + capacitySpent),
          reason: "Debt remediation",
        },
        {
          resource: Resources.Money,
          amount: -(totalRetired * this.options.moneyPerDebtRetired),
          reason: "Maintenance cost",
        },
        {
          resource: Resources.Bugs,
          amount: interestBugs,
          reason: "Technical debt interest",
        },
        {
          resource: Resources.Insight,
          amount: Math.floor(totalRetired / 2),
          reason: "Maintenance learning",
        },
      ],
      statePatch: {
        retired: state.retired + totalRetired,
        interestIncidents: state.interestIncidents + interestBugs,
        peakDebt: Math.max(state.peakDebt, debt),
        principalByCategory: remainingPrincipalByCategory,
        lastRemediation: {
          availableCapacity: maintenanceCapacity,
          capacitySpent: manualCapacitySpent + capacitySpent,
          maintainable: manualPotential + maintainable,
          affordableDebt,
          retired: totalRetired,
          debtBefore: debt,
        },
        manualPaydown: null,
        ...(manual === null || manual === undefined ? {} : {
          lastManualPaydown: {
            tick: view.tick, categoryId: manual.categoryId, requested: manual.amount,
            retired: manualRetired, capacitySpent: manualCapacitySpent,
            moneySpent: manualRetired * this.options.moneyPerDebtRetired,
          },
        }),
      },
      events,
    };
  }

  private retireDebt(
    principals: Readonly<Record<string, number>>,
    categories: readonly DebtCategoryCohort[],
    amount: number,
  ): Readonly<Record<string, number>> {
    const result = { ...principals };
    let remaining = amount;
    const prioritized = [...categories].sort(
      (left, right) =>
        right.maintenanceEfficiencyPermille -
          left.maintenanceEfficiencyPermille ||
        left.id.localeCompare(right.id),
    );
    for (const category of prioritized) {
      const principal = result[category.id] ?? 0;
      const retired = Math.min(remaining, principal);
      result[category.id] = principal - retired;
      remaining -= retired;
      if (remaining === 0) {
        break;
      }
    }
    return result;
  }
}

interface PayDownPayload extends JsonObject {
  readonly categoryId: string;
  readonly amount: number;
}

function createManualPaydownHandler(): CommandHandler<PayDownPayload> {
  return {
    id: TECHNICAL_DEBT_SYSTEM_ID,
    type: "debt.pay-down",
    reads: [Resources.TechnicalDebt],
    writes: [],
    stateReads: [],
    eventReads: [],
    emits: [],
    handle: (command, view) => {
      const { categoryId, amount } = command.payload;
      if (!Number.isSafeInteger(amount) || amount < 1 || amount > 1_000) {
        throw new Error("Manual paydown amount must be an integer from 1 to 1000");
      }
      const state = view.getSystemState<TechnicalDebtState>(TECHNICAL_DEBT_SYSTEM_ID);
      if (state.manualPaydown !== undefined && state.manualPaydown !== null) {
        throw new Error("A manual debt paydown is already scheduled this tick");
      }
      if (!state.categories.some((category) => category.id === categoryId)) {
        throw new Error(`Unknown debt category: ${categoryId}`);
      }
      if (view.resources.get(Resources.TechnicalDebt) === 0) {
        throw new Error("There is no debt to pay down");
      }
      return { statePatch: { manualPaydown: { categoryId, amount } } };
    },
  };
}

export function createTechnicalDebtLayer(
  options: TechnicalDebtLayerOptions,
): SimulationLayer {
  return {
    id: TECHNICAL_DEBT_LAYER_ID,
    name: "Technical Debt & Maintenance",
    pipeline: {
      id: TECHNICAL_DEBT_LAYER_ID,
      displayName: "Technical Debt & Maintenance",
      dependsOn: [KNOWLEDGE_LAYER_ID],
      inputs: [
        Resources.TechnicalDebt,
        Resources.MaintenanceCapacity,
        Resources.Money,
        Resources.Knowledge,
      ],
      outputs: [Resources.Bugs, Resources.Insight],
    },
    systems: [new TechnicalDebtSystem(options)],
    commandHandlers: [createManualPaydownHandler()],
    eventHandlers: [],
    feedbackLoops: [
      "Debt slows source and builds and creates defects; organization policy reserves maintenance capacity to retire it.",
    ],
    performanceNotes: [
      "Debt is modeled as category cohorts and aggregate principal, not one entity per shortcut.",
    ],
  };
}
