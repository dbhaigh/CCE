export interface DirectedGraphNode {
  readonly id: string;
  readonly dependencies: readonly string[];
}

export function topologicalOrder<T extends DirectedGraphNode>(
  nodes: readonly T[],
  graphName: string,
): readonly T[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  if (byId.size !== nodes.length) {
    throw new Error(`${graphName} IDs must be unique`);
  }

  for (const node of nodes) {
    for (const dependency of node.dependencies) {
      if (!byId.has(dependency)) {
        throw new Error(
          `${graphName} node ${node.id} has unknown dependency ${dependency}`,
        );
      }
    }
  }

  const ordered: T[] = [];
  const remaining = new Set(byId.keys());
  while (remaining.size > 0) {
    const ready = [...remaining]
      .map((id) => byId.get(id))
      .filter((node): node is T => node !== undefined)
      .filter((node) =>
        node.dependencies.every((dependency) =>
          ordered.some((completed) => completed.id === dependency),
        ),
      )
      .sort((left, right) => left.id.localeCompare(right.id));
    if (ready.length === 0) {
      throw new Error(
        `${graphName} contains a cycle: ${[...remaining].sort().join(", ")}`,
      );
    }
    for (const node of ready) {
      remaining.delete(node.id);
      ordered.push(node);
    }
  }
  return ordered;
}
