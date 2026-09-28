import {
  SimulationPhase,
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
  public readonly emits = ["debt.maintained", "debt.interest-accrued"];

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
    const trackedPrincipal = Object.values(principalByCategory).reduce(
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
                (principalByCategory[category.id] ?? 0) *
                  category.maintenanceEfficiencyPermille,
              0,
            ) / trackedPrincipal,
          );
    const knowledgeEfficiency = Math.min(
      2_000,
      1_000 + view.resources.get(Resources.Knowledge) * 5,
    );
    const maintainable = Math.floor(
      (maintenanceCapacity *
        this.options.debtPerMaintenanceCapacity *
        knowledgeEfficiency *
        averageMaintenanceEfficiency) /
        1_000_000,
    );
    const retired = Math.min(debt, maintainable, affordableDebt);
    const capacitySpent =
      retired === 0
        ? 0
        : Math.min(
            maintenanceCapacity,
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
    const remainingDebt = debt - retired;
    const remainingPrincipalByCategory = this.retireDebt(
      principalByCategory,
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
    if (retired > 0) {
      events.push({
        type: "debt.maintained",
        payload: { retired, remainingDebt },
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
          amount: -retired,
          reason: "Maintenance work",
        },
        {
          resource: Resources.MaintenanceCapacity,
          amount: -capacitySpent,
          reason: "Debt remediation",
        },
        {
          resource: Resources.Money,
          amount: -(retired * this.options.moneyPerDebtRetired),
          reason: "Maintenance cost",
        },
        {
          resource: Resources.Bugs,
          amount: interestBugs,
          reason: "Technical debt interest",
        },
        {
          resource: Resources.Insight,
          amount: Math.floor(retired / 2),
          reason: "Maintenance learning",
        },
      ],
      statePatch: {
        retired: state.retired + retired,
        interestIncidents: state.interestIncidents + interestBugs,
        peakDebt: Math.max(state.peakDebt, debt),
        principalByCategory: remainingPrincipalByCategory,
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
    commandHandlers: [],
    eventHandlers: [],
    feedbackLoops: [
      "Debt slows source and builds and creates defects; organization policy reserves maintenance capacity to retire it.",
    ],
    performanceNotes: [
      "Debt is modeled as category cohorts and aggregate principal, not one entity per shortcut.",
    ],
  };
}
