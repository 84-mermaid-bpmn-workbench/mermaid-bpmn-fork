import { type ModdleElement } from 'bpmn-moddle';
import {
  ACTIVITY_CONTAINER_TYPES,
  NAME_AS_LABEL_TYPES,
  type ActivityMarker,
  type ActivityType,
  type DataType,
  type Entity,
  type EntityType,
  type EventOperation,
  type EventType,
  type GateType,
  type Line,
  type LineType,
  type Side,
  type SlashEnd,
  type TaskType,
} from './db.js';
import { moddle } from './moddle.js';
import { readLayout, type Bounds } from './xml-to-domain.js';

/**
 * Read a BPMN 2.0 document into the domain model — `domain-to-xml` backwards.
 *
 * The two directions are not symmetric, because BPMN and the DSL disagree about
 * what contains what. Every relation the exporter flattens is folded back here:
 *
 * - a participant's process is unpacked into the pool, and its lanes become the
 *   pool's bands;
 * - a lane claims its members by listing them, so the listed nodes are moved
 *   into it;
 * - a boundary event is a flow node of the enclosing scope carrying an
 *   `attachedToRef`, so it is moved into the activity it guards;
 * - a group owns nothing at all — its box is simply drawn over other shapes — so
 *   its members are recovered from their category references, or from the
 *   drawn boxes when the document does not state them.
 *
 * Beyond that, the diagram interchange section is used wherever the semantic
 * model alone is ambiguous: whether a sub-process is drawn open or collapsed,
 * which edge a boundary event sits on, and — since a modeller lists its
 * elements in whatever order they were created — the order a reader would walk
 * through them in. A document with no DI still converts; it just keeps the
 * document order and expands every sub-process.
 *
 * Nothing about appearance is read: BPMN carries no styling this DSL could use,
 * so colors, icons and classes are never set.
 */

export interface DomainModel {
  /** The top-level entities — what `db.getEntities()` holds after a parse. */
  entities: Entity[];
  /** The connections, with both endpoints resolved to entities. */
  lines: Line[];
}

/** The BPMN element for each event role, inverted. */
const EVENT_OPERATIONS: ReadonlyMap<string, EventOperation> = new Map<string, EventOperation>([
  ['bpmn:StartEvent', 'start'],
  ['bpmn:IntermediateCatchEvent', 'catch'],
  ['bpmn:IntermediateThrowEvent', 'throw'],
  ['bpmn:ImplicitThrowEvent', 'throw'],
  ['bpmn:EndEvent', 'end'],
  ['bpmn:BoundaryEvent', 'boundary'],
]);

const GATE_TYPES: ReadonlyMap<string, GateType> = new Map<string, GateType>([
  ['bpmn:ExclusiveGateway', 'exclusive'],
  ['bpmn:InclusiveGateway', 'inclusive'],
  ['bpmn:ParallelGateway', 'parallel'],
  ['bpmn:EventBasedGateway', 'event'],
  ['bpmn:ComplexGateway', 'complex'],
]);

/** The activity family each BPMN element belongs to. Every task kind is a task. */
const ACTIVITY_TYPES: ReadonlyMap<string, ActivityType> = new Map<string, ActivityType>([
  ['bpmn:Task', 'task'],
  ['bpmn:UserTask', 'task'],
  ['bpmn:ServiceTask', 'task'],
  ['bpmn:SendTask', 'task'],
  ['bpmn:ReceiveTask', 'task'],
  ['bpmn:ManualTask', 'task'],
  ['bpmn:ScriptTask', 'task'],
  ['bpmn:BusinessRuleTask', 'task'],
  ['bpmn:CallActivity', 'call'],
  ['bpmn:SubProcess', 'subprocess'],
  ['bpmn:AdHocSubProcess', 'subprocess'],
  ['bpmn:Transaction', 'transaction'],
]);

/** The corner glyph each task element carries. */
const TASK_TYPES: ReadonlyMap<string, TaskType> = new Map<string, TaskType>([
  ['bpmn:UserTask', 'user'],
  ['bpmn:ServiceTask', 'service'],
  ['bpmn:SendTask', 'send'],
  ['bpmn:ReceiveTask', 'receive'],
  ['bpmn:ManualTask', 'manual'],
  ['bpmn:ScriptTask', 'script'],
  ['bpmn:BusinessRuleTask', 'rule'],
]);

/** The trigger each event definition stands for. */
const EVENT_TYPES: ReadonlyMap<string, EventType> = new Map<string, EventType>([
  ['bpmn:MessageEventDefinition', 'message'],
  ['bpmn:TimerEventDefinition', 'timer'],
  ['bpmn:ConditionalEventDefinition', 'conditional'],
  ['bpmn:LinkEventDefinition', 'link'],
  ['bpmn:SignalEventDefinition', 'signal'],
  ['bpmn:ErrorEventDefinition', 'error'],
  ['bpmn:EscalationEventDefinition', 'escalation'],
  ['bpmn:TerminateEventDefinition', 'termination'],
  ['bpmn:CompensateEventDefinition', 'compensation'],
  ['bpmn:CancelEventDefinition', 'cancel'],
]);

/** Elements that are flow elements but never drawn — the reference is. */
const UNDRAWN: ReadonlySet<string> = new Set([
  'bpmn:DataObject',
  'bpmn:DataInput',
  'bpmn:DataOutput',
  'bpmn:Property',
]);

/** A connection found while walking, resolved once every entity exists. */
interface PendingLine {
  source: ModdleElement | undefined;
  target: ModdleElement | undefined;
  type: LineType;
  label?: string;
  slash?: SlashEnd;
}

function isElement(value: unknown): value is ModdleElement {
  return typeof value === 'object' && value !== null && typeof (value as ModdleElement).$type === 'string';
}

/** A single-valued reference, or undefined when absent or not an element. */
function asElement(value: unknown): ModdleElement | undefined {
  return isElement(value) ? value : undefined;
}

/**
 * A reference list. Several BPMN properties are declared as a collection but
 * written as a single value by some tools, so both shapes are accepted.
 */
function asElements(value: unknown): ModdleElement[] {
  if (Array.isArray(value)) return value.filter(isElement);
  return isElement(value) ? [value] : [];
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** XML booleans reach us as booleans, unless the attribute is off the meta model. */
function isTrue(value: unknown): boolean {
  return value === true || value === 'true';
}

function isFalse(value: unknown): boolean {
  return value === false || value === 'false';
}

/** Read a BPMN 2.0 document into the domain model. */
export async function bpmnXmlToDomainModel(xml: string): Promise<DomainModel> {
  const { rootElement } = await moddle().fromXML(xml);
  return definitionsToDomainModel(rootElement);
}

/** The same conversion on an already-parsed `bpmn:Definitions`. */
export function definitionsToDomainModel(definitions: ModdleElement): DomainModel {
  const { entityBounds, expanded } = readLayout(definitions);
  // A shape of zero size is not a drawn box: that is the carrier this project's
  // exporter uses for `isExpanded` on a document it is about to have laid out,
  // and reading those as a diagram would order the source by boxes that were
  // never placed. Without any drawn box there is no diagram at all, and every
  // decision below falls back to the document itself.
  const drawn = new Map(
    [...entityBounds].filter(([, box]) => box.width > 0 && box.height > 0),
  );
  const hasDi = drawn.size > 0;

  const entities: Entity[] = [];
  const lines: Line[] = [];

  /** The entity a converted element became, and the way back. */
  const entityOf = new Map<ModdleElement, Entity>();
  const elementOf = new Map<Entity, ModdleElement>();
  /** The child list an entity currently sits in, so a later pass can move it. */
  const siblingsOf = new Map<Entity, Entity[]>();
  /** The drawn box of an entity, when the document brought a diagram. */
  const boundsOf = new Map<Entity, Bounds>();

  const groups: Entity[] = [];
  const boundaries: { entity: Entity; host?: ModdleElement; fallback: () => Entity[] }[] = [];
  const connections: PendingLine[] = [];

  const push = (target: Entity[], entity: Entity): void => {
    target.push(entity);
    siblingsOf.set(entity, target);
  };

  function makeEntity(element: ModdleElement, type: EntityType, caption?: string): Entity {
    const entity: Entity = { name: element.id ?? '', type, children: [] };
    const label = caption ?? str(element.name) ?? '';
    // `label` is only written when the caption differs from what the family
    // draws anyway — its id for the name-as-label families, nothing for the
    // rest — so the model carries no redundant quoted labels.
    if (label !== (NAME_AS_LABEL_TYPES.has(type) ? entity.name : '')) entity.label = label;

    entityOf.set(element, entity);
    elementOf.set(entity, element);
    const bounds = element.id === undefined ? undefined : drawn.get(element.id);
    if (bounds) boundsOf.set(entity, bounds);
    return entity;
  }

  /** The trigger glyph of an event: none, one definition, or several. */
  function eventTypeOf(element: ModdleElement): EventType | undefined {
    const definitions = asElements(element.eventDefinitions);
    if (definitions.length === 0) return undefined;
    if (definitions.length > 1) return isTrue(element.parallelMultiple) ? 'parallel' : 'multiple';
    return EVENT_TYPES.get(definitions[0].$type);
  }

  /** The marker at the bottom of an activity, if it carries one. */
  function markerOf(element: ModdleElement): ActivityMarker | undefined {
    if (element.$type === 'bpmn:AdHocSubProcess') return 'adhoc';
    const loop = asElement(element.loopCharacteristics);
    if (loop) {
      if (loop.$type === 'bpmn:StandardLoopCharacteristics') return 'loop';
      return isTrue(loop.isSequential) ? 'sequential' : 'parallel';
    }
    if (isTrue(element.isForCompensation)) return 'compensation';
    return undefined;
  }

  /**
   * Whether a sub-process is drawn as a closed box.
   *
   * The semantic model says nothing about it: the contents are in the document
   * either way, and only the DI shape's `isExpanded` decides whether they are
   * drawn. A document without a diagram is taken at face value and expanded.
   */
  function isCollapsed(element: ModdleElement): boolean {
    return hasDi && !(element.id !== undefined && expanded.has(element.id));
  }

  function convertNode(element: ModdleElement): Entity | undefined {
    const type = element.$type;

    const eventOperation = EVENT_OPERATIONS.get(type);
    if (eventOperation) {
      const entity = makeEntity(element, 'event');
      // The dashed ring is spelled `isInterrupting` on a start event and
      // `cancelActivity` on a boundary event.
      entity.eventOperation =
        eventOperation === 'start' && isFalse(element.isInterrupting)
          ? 'non-interrupt'
          : eventOperation === 'boundary' && isFalse(element.cancelActivity)
            ? 'boundary-non-interrupt'
            : eventOperation;
      const eventType = eventTypeOf(element);
      if (eventType) entity.eventType = eventType;
      return entity;
    }

    const gateType = GATE_TYPES.get(type);
    if (gateType) {
      const entity = makeEntity(element, 'gate');
      if (gateType !== 'exclusive') entity.gateType = gateType;
      return entity;
    }

    if (type === 'bpmn:DataObjectReference' || type === 'bpmn:DataStoreReference') {
      const entity = makeEntity(element, 'data');
      // A collection is a data object whose underlying object is one — the
      // reference itself carries nothing.
      const dataType: DataType =
        type === 'bpmn:DataStoreReference'
          ? 'store'
          : isTrue(asElement(element.dataObjectRef)?.isCollection)
            ? 'collection'
            : 'object';
      if (dataType !== 'object') entity.dataType = dataType;
      return entity;
    }

    if (type === 'bpmn:TextAnnotation') {
      return makeEntity(element, 'text', str(element.text) ?? '');
    }

    if (type === 'bpmn:Group') {
      // A group's caption is a shared category value, not an attribute.
      const value = asElement(element.categoryValueRef);
      const entity = makeEntity(element, 'group', str(value?.value) ?? '');
      groups.push(entity);
      return entity;
    }

    const activityType = ACTIVITY_TYPES.get(type);
    if (!activityType) return undefined;

    const entity = makeEntity(element, 'activity');
    entity.activityType =
      activityType === 'subprocess' && isTrue(element.triggeredByEvent)
        ? 'event-subprocess'
        : activityType;
    const taskType = TASK_TYPES.get(type);
    if (taskType) {
      entity.taskType = taskType === 'receive' && isTrue(element.instantiate)
        ? 'receive-instance'
        : taskType;
    }
    const marker = markerOf(element);
    if (marker) entity.marker = marker;

    if (ACTIVITY_CONTAINER_TYPES.has(entity.activityType) && !isCollapsed(element)) {
      // A sub-process holds a scope of its own. Lanes inside one are ignored —
      // the DSL nests bands in a pool, not in an activity.
      convertScope(element, entity.children, null);
    }
    return entity;
  }

  /** Build the bands of a process, flattened: the DSL has no lane inside a lane. */
  function collectLanes(
    laneSet: ModdleElement,
    target: Entity[],
    laneOf: Map<ModdleElement, Entity>,
    lanes: Entity[],
  ): void {
    for (const lane of asElements(laneSet.lanes)) {
      const entity = makeEntity(lane, 'lane');
      push(target, entity);
      lanes.push(entity);
      for (const member of asElements(lane.flowNodeRef)) laneOf.set(member, entity);
      const childSet = asElement(lane.childLaneSet);
      // A nested lane becomes a band beside its parent, and claims its own
      // members afterwards so the innermost lane wins.
      if (childSet) collectLanes(childSet, target, laneOf, lanes);
    }
  }

  /**
   * Convert one BPMN scope — a process or a sub-process — into `target`.
   *
   * `pool` is set only for the process of a participant, where the DSL draws
   * bands rather than nodes: anything the document filed outside every lane
   * gets a band of its own.
   */
  function convertScope(scope: ModdleElement, target: Entity[], pool: Entity | null): void {
    const laneOf = new Map<ModdleElement, Entity>();
    const lanes: Entity[] = [];
    for (const laneSet of asElements(scope.laneSets)) collectLanes(laneSet, target, laneOf, lanes);

    let spill: Entity[] | undefined;
    const bandFor = (element: ModdleElement): Entity[] => {
      const lane = laneOf.get(element);
      if (lane) return lane.children;
      if (!pool) return target;

      // A lane lists flow NODES: an artifact drawn inside one — a group, an
      // annotation — is claimed by nothing, so it is placed by its box instead.
      // The tightest band wins, in case they are nested.
      const box = element.id === undefined ? undefined : drawn.get(element.id);
      if (box) {
        let band: Entity | undefined;
        for (const candidate of lanes) {
          const bounds = boundsOf.get(candidate);
          if (!bounds || !covers(bounds, box)) continue;
          if (!band || areaOf(candidate) < areaOf(band)) band = candidate;
        }
        if (band) return band.children;
      }

      if (!spill) {
        const band: Entity = { name: '', type: 'lane', children: [] };
        push(target, band);
        spill = band.children;
      }
      return spill;
    };

    for (const element of [...asElements(scope.flowElements), ...asElements(scope.artifacts)]) {
      const type = element.$type;

      if (type === 'bpmn:SequenceFlow') {
        const source = asElement(element.sourceRef);
        connections.push({
          source,
          target: asElement(element.targetRef),
          type: '-->',
          label: str(element.name) || undefined,
          // The default branch is marked by the gateway pointing back at it.
          slash: source && asElement(source.default) === element ? 'start' : undefined,
        });
        continue;
      }
      if (type === 'bpmn:Association' || type === 'bpmn:DataAssociation') {
        connections.push({
          source: asElement(element.sourceRef) ?? asElements(element.sourceRef)[0],
          target: asElement(element.targetRef),
          type: '---',
          label: str(element.name) || undefined,
        });
        continue;
      }
      if (UNDRAWN.has(type)) continue;

      const entity = convertNode(element);
      if (!entity) continue;

      if (type === 'bpmn:BoundaryEvent') {
        // Placed once its host exists — it is a flow node here, but a child of
        // the activity it guards in the DSL.
        boundaries.push({
          entity,
          host: asElement(element.attachedToRef),
          fallback: () => bandFor(element),
        });
      } else {
        push(bandFor(element), entity);
      }

      // Data associations are written inside the activity rather than beside
      // it, and are the usual way a modeller links a data object to a task.
      for (const association of asElements(element.dataInputAssociations)) {
        for (const source of asElements(association.sourceRef)) {
          connections.push({ source, target: element, type: '---' });
        }
      }
      for (const association of asElements(element.dataOutputAssociations)) {
        for (const dataTarget of asElements(association.targetRef)) {
          connections.push({ source: element, target: dataTarget, type: '---' });
        }
      }
    }
  }

  // --- the document ----------------------------------------------------------

  const rootElements = asElements(definitions.rootElements);
  const claimed = new Set<ModdleElement>();

  for (const collaboration of rootElements.filter((e) => e.$type === 'bpmn:Collaboration')) {
    for (const participant of asElements(collaboration.participants)) {
      const process = asElement(participant.processRef);
      if (process) claimed.add(process);

      // A participant with neither a name nor a box is not a pool anyone can
      // see: this project's exporter adds one to carry the elements that sit
      // outside every pool. Unwrap it rather than invent a band structure for
      // it. An anonymous participant that IS drawn stays a pool.
      if (!str(participant.name) && !(participant.id !== undefined && drawn.has(participant.id))) {
        if (process) convertScope(process, entities, null);
        continue;
      }

      const pool = makeEntity(participant, 'pool');
      push(entities, pool);
      // A participant without a process is a black box: an empty pool.
      if (process) convertScope(process, pool.children, pool);
    }

    for (const flow of asElements(collaboration.messageFlows)) {
      connections.push({
        source: asElement(flow.sourceRef),
        target: asElement(flow.targetRef),
        type: '-->',
        label: str(flow.name) || undefined,
      });
    }
  }

  for (const process of rootElements.filter((e) => e.$type === 'bpmn:Process')) {
    if (!claimed.has(process)) convertScope(process, entities, null);
  }

  // --- the passes that need every entity -------------------------------------

  for (const { entity, host, fallback } of boundaries) {
    const hostEntity = host ? entityOf.get(host) : undefined;
    if (!hostEntity) {
      // Nothing to attach to; it draws as an ordinary event where it was found.
      push(fallback(), entity);
      continue;
    }
    push(hostEntity.children, entity);
    const side = boundarySideOf(entity, hostEntity);
    if (side) entity.boundarySide = side;
  }

  for (const { source, target, type, label, slash } of connections) {
    const from = source && entityOf.get(source);
    const to = target && entityOf.get(target);
    // An endpoint that was never drawn (a data input inside an activity, an
    // element of a collapsed sub-process) leaves nothing to connect.
    if (!from || !to || from === to) continue;
    const line: Line = { source: from, target: to, type };
    if (label) line.label = label;
    if (slash) line.slash = slash;
    lines.push(line);
  }

  // A group owns nothing in BPMN: its box is simply drawn over other shapes.
  // Membership comes from the members' own category references when the
  // document states them, and from the boxes otherwise. Smallest box first, so
  // a group inside another ends up nested rather than beside it.
  for (const group of [...groups].sort((a, b) => areaOf(a) - areaOf(b))) {
    const siblings = siblingsOf.get(group);
    if (!siblings) continue;
    for (const member of membersOf(group, siblings)) {
      siblings.splice(siblings.indexOf(member), 1);
      push(group.children, member);
    }
  }

  sortTree(entities);
  return { entities, lines };

  function membersOf(group: Entity, siblings: Entity[]): Entity[] {
    const value = asElement(elementOf.get(group)?.categoryValueRef);
    const candidates = siblings.filter((entity) => entity !== group);
    if (value) {
      const declared = candidates.filter((entity) =>
        asElements(elementOf.get(entity)?.categoryValueRef).includes(value),
      );
      if (declared.length > 0) return declared;
    }
    const box = boundsOf.get(group);
    if (!box) return [];
    return candidates.filter((entity) => covers(box, boundsOf.get(entity)));
  }

  /**
   * Whether a box is drawn around another, whole.
   *
   * Containment has to be complete, not just of the centre: a group nested in
   * another otherwise reads as a member of the box it is drawn beside, and the
   * two would swallow each other.
   */
  function covers(box: Bounds, inner: Bounds | undefined): boolean {
    if (!inner) return false;
    return (
      inner.x >= box.x - 1 &&
      inner.y >= box.y - 1 &&
      inner.x + inner.width <= box.x + box.width + 1 &&
      inner.y + inner.height <= box.y + box.height + 1
    );
  }

  function areaOf(entity: Entity): number {
    const box = boundsOf.get(entity);
    // A group with no shape claims nothing, so it can be dealt with last.
    return box ? box.width * box.height : Number.POSITIVE_INFINITY;
  }

  /** Which host edge a boundary event's ring straddles. */
  function boundarySideOf(entity: Entity, host: Entity): Side | undefined {
    const ring = boundsOf.get(entity);
    const box = boundsOf.get(host);
    if (!ring || !box) return undefined;
    const x = ring.x + ring.width / 2;
    const y = ring.y + ring.height / 2;
    const distances: [Side, number][] = [
      ['w', Math.abs(x - box.x)],
      ['e', Math.abs(x - (box.x + box.width))],
      ['n', Math.abs(y - box.y)],
      ['s', Math.abs(y - (box.y + box.height))],
    ];
    return distances.reduce((best, next) => (next[1] < best[1] ? next : best))[0];
  }

  /**
   * Put every child list in reading order.
   *
   * A modeller lists its elements in creation order, which says nothing about
   * where they ended up. Sorting along the axis the siblings actually extend in
   * — across for a lane, down for the bands of a horizontal pool — recovers the
   * order a reader follows them in. Shapeless entities keep their document
   * order at the end of the list.
   */
  function sortTree(children: Entity[]): void {
    if (children.length > 1) {
      const placed = children.filter((entity) => boundsOf.has(entity));
      const rest = children.filter((entity) => !boundsOf.has(entity));
      const box = boundingBox(placed);
      const horizontal = !box || box.width >= box.height;
      placed.sort((a, b) => {
        const first = boundsOf.get(a)!;
        const second = boundsOf.get(b)!;
        const primary = horizontal ? first.x - second.x : first.y - second.y;
        // Siblings that share the primary coordinate — the bands of a pool, a
        // fork's branches — are ordered by the other axis.
        if (Math.abs(primary) > 1) return primary;
        return horizontal ? first.y - second.y : first.x - second.x;
      });
      children.splice(0, children.length, ...placed, ...rest);
    }
    for (const child of children) sortTree(child.children);
  }

  function boundingBox(children: Entity[]): Bounds | undefined {
    let box: Bounds | undefined;
    for (const child of children) {
      const bounds = boundsOf.get(child);
      if (!bounds) continue;
      if (!box) {
        box = { ...bounds };
        continue;
      }
      const right = Math.max(box.x + box.width, bounds.x + bounds.width);
      const bottom = Math.max(box.y + box.height, bounds.y + bounds.height);
      box.x = Math.min(box.x, bounds.x);
      box.y = Math.min(box.y, bounds.y);
      box.width = right - box.x;
      box.height = bottom - box.y;
    }
    return box;
  }
}
