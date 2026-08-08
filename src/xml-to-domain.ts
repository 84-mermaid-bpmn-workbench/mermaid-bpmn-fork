import { type ModdleElement } from 'bpmn-moddle';
import { type Entity, type Line } from './db.js';
import { moddle } from './moddle.js';

/**
 * Parse the BPMN XML produced by bpmn-auto-layout back into plain layout data.
 *
 * Only the diagram interchange (DI) section is of interest: shape bounds and
 * edge waypoints. bpmn-moddle resolves the `bpmnElement` attribute to the
 * referenced element, so both are keyed by the ids that `domainToBpmnXml`
 * generated without having to match namespace prefixes or attributes by hand.
 */

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Waypoint {
  x: number;
  y: number;
}

export interface LayoutedDomain {
  /** BPMN element id -> shape bounds. */
  entityBounds: Map<string, Bounds>;
  /** BPMN sequence flow id -> edge waypoints. */
  lineWaypoints: Map<string, Waypoint[]>;
  /**
   * Ids of the elements whose shape carries `isExpanded`. Irrelevant to the
   * layout round trip — a sub-process this module reads back was expanded by
   * definition — but it is the only place a foreign document says whether a
   * sub-process is drawn open or collapsed, which the importer needs.
   */
  expanded: Set<string>;
}

/** The slice of the DI model that is read here. */
interface PlaneElement extends ModdleElement {
  bpmnElement?: ModdleElement;
  bounds?: { x?: number; y?: number; width?: number; height?: number };
  waypoint?: { x?: number; y?: number }[];
  isExpanded?: boolean;
}

function num(value: number | undefined): number {
  return Number.isFinite(value) ? (value as number) : 0;
}

export async function bpmnXmlToDomain(xml: string): Promise<LayoutedDomain> {
  const { rootElement } = await moddle().fromXML(xml);
  return readLayout(rootElement);
}

/**
 * The same read on an already-parsed document.
 *
 * Split out so a caller that has to look at the semantic model anyway — the
 * importer — gets the geometry from the parse it already did instead of running
 * the XML through moddle a second time.
 */
export function readLayout(definitions: ModdleElement): LayoutedDomain {
  const entityBounds = new Map<string, Bounds>();
  const lineWaypoints = new Map<string, Waypoint[]>();
  const expanded = new Set<string>();

  const diagrams = (definitions.diagrams as ModdleElement[] | undefined) ?? [];

  for (const diagram of diagrams) {
    const plane = diagram.plane as ModdleElement | undefined;
    const planeElements = (plane?.planeElement as PlaneElement[] | undefined) ?? [];

    for (const element of planeElements) {
      const id = element.bpmnElement?.id;
      if (!id) continue;

      if (element.isExpanded === true) expanded.add(id);

      const bounds = element.bounds;
      if (bounds) {
        entityBounds.set(id, {
          x: num(bounds.x),
          y: num(bounds.y),
          width: num(bounds.width),
          height: num(bounds.height),
        });
      }

      const waypoints = element.waypoint ?? [];
      if (waypoints.length > 0) {
        lineWaypoints.set(
          id,
          waypoints.map((w) => ({ x: num(w.x), y: num(w.y) })),
        );
      }
    }
  }

  return { entityBounds, lineWaypoints, expanded };
}

/**
 * Write the computed layout back onto the domain model.
 *
 * Entities and lines are addressed through the id maps produced by
 * `domainToBpmnXml`, so entities with empty or duplicated names are handled
 * correctly.
 */
export function applyLayoutCoordinates(
  nodeIds: Map<string, Entity>,
  flowIds: Map<string, { line: Line }>,
  layout: LayoutedDomain,
): void {
  for (const [id, entity] of nodeIds) {
    const bounds = layout.entityBounds.get(id);
    if (!bounds) continue;
    const target = entity as unknown as Record<string, unknown>;
    target.x = bounds.x;
    target.y = bounds.y;
    target.width = bounds.width;
    target.height = bounds.height;
  }

  for (const [id, flow] of flowIds) {
    const waypoints = layout.lineWaypoints.get(id);
    if (!waypoints) continue;
    (flow.line as unknown as Record<string, unknown>).waypoints = waypoints;
  }
}
