import {
  ACTIVITY_CONTAINER_TYPES,
  BOUNDARY_OPERATIONS,
  NAME_AS_LABEL_TYPES,
  entityLabel,
  type ActivityMarker,
  type ActivityType,
  type Entity,
  type EventOperation,
  type Line,
} from './db.js';

/**
 * Write the domain model back out as DSL source — the parser in reverse.
 *
 * The output is deliberately plain: structure only. No styling, no `route`, no
 * `direction`, and `layout auto` on the first line, so the layouter — not the
 * source — decides where anything ends up.
 *
 * Two shapes of the same text are produced. `braces: false` nests by
 * indentation; `braces: true` opens a `{` on every declaration that has
 * children and closes it on its own line. Nothing else differs — the same
 * declarations in the same order at the same indentation — so the two can be
 * diffed line for line.
 *
 * Every connection is written as an absolute line naming both endpoints, placed
 * directly after its source's declaration. That needs both ends to be
 * referenceable, so an entity that is a line endpoint always gets an id, one
 * generated for it if its own name cannot be written as a reference.
 */

export interface SourceOptions {
  /** Nest with `{ }` rather than by indentation alone. */
  braces?: boolean;
  /**
   * Write the edge a boundary event is pinned to (`timer boundary e1 s`).
   *
   * Off by default: the side is a placement hint, and left out the renderer
   * derives one from the host's layout direction. It is worth keeping when the
   * model came from a diagram that had the event somewhere deliberate.
   */
  boundarySides?: boolean;
}

const INDENT = '  ';

/**
 * Names that can be written as a reference verbatim.
 *
 * The DSL does accept an id of several words (`task Receive Task`), but a
 * trailing word is read as a direction or a compass side on several families,
 * and an id is only ever compared as a whole. A single word of the BPMN id
 * alphabet is the shape that is safe everywhere.
 */
const VALID_ID_RE = /^[A-Za-z_][\w.-]*$/;

/**
 * The words a declaration reads as a trailing modifier before it reads an id: a
 * layout direction on the families that lay their children out, a compass side
 * on the ones that pin something to an edge. Either is only a hazard for the
 * families that accept it — `task e` is an ordinary id.
 */
const DIRECTION_WORDS: ReadonlySet<string> = new Set([
  'tb', 'td', 'bt', 'lr', 'rl', 'vertical', 'horizontal',
]);
const SIDE_WORDS: ReadonlySet<string> = new Set([
  'n', 'north', 'e', 'east', 's', 'south', 'w', 'west', 'auto',
]);

/** The keyword for each activity family. */
const ACTIVITY_WORDS: Record<ActivityType, string> = {
  task: 'task',
  subprocess: 'subprocess',
  call: 'call',
  'call-subprocess': 'call-subprocess',
  'event-subprocess': 'event-subprocess',
  transaction: 'transaction',
};

/** The keyword for each marker. `instance` is the default and is never written. */
const MARKER_WORDS: Record<ActivityMarker, string> = {
  instance: '',
  loop: 'loop',
  sequential: 'sequential',
  parallel: 'parallel',
  compensation: 'compensation',
  adhoc: 'ad-hoc',
};

/** The words for each event role, in the order the parser reads them. */
const OPERATION_WORDS: Record<EventOperation, string[]> = {
  start: ['start'],
  'non-interrupt': ['non-interrupting'],
  catch: ['catch'],
  throw: ['throw'],
  end: ['end'],
  boundary: ['boundary'],
  'boundary-non-interrupt': ['non-interrupting', 'boundary'],
};

/** The families that read a trailing layout direction off their declaration. */
function takesDirection(entity: Entity): boolean {
  if (entity.type === 'activity') {
    return ACTIVITY_CONTAINER_TYPES.has(entity.activityType ?? 'task');
  }
  return ['pool', 'lane', 'region', 'group'].includes(entity.type);
}

/** The families that read a trailing compass side off their declaration. */
function takesSide(entity: Entity): boolean {
  if (entity.type === 'event') {
    return entity.eventOperation !== undefined && BOUNDARY_OPERATIONS.has(entity.eventOperation);
  }
  return entity.type === 'text' || entity.type === 'port';
}

/** Whether an entity's own name can be written as its reference. */
function isUsableName(entity: Entity): boolean {
  if (!VALID_ID_RE.test(entity.name)) return false;
  const word = entity.name.toLowerCase();
  if (DIRECTION_WORDS.has(word) && takesDirection(entity)) return false;
  if (SIDE_WORDS.has(word) && takesSide(entity)) return false;
  return true;
}

/** A quoted label: line breaks become `\ `, quotes and backslashes are escaped. */
function quote(text: string): string {
  const escaped = text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, '\\ ');
  return `"${escaped}"`;
}

/** Whether an entity is written at all. Diagnostics are not part of a source. */
function emittable(entity: Entity): boolean {
  return entity.type !== 'error';
}

export function domainToSource(
  entities: Entity[],
  lines: Line[],
  options: SourceOptions = {},
): string {
  const { braces = false, boundarySides = false } = options;

  const all: Entity[] = [];
  const collect = (children: Entity[]): void => {
    for (const child of children) {
      if (!emittable(child)) continue;
      all.push(child);
      collect(child.children);
    }
  };
  collect(entities);

  const ids = assignIds(all, lines);

  // Every line is written after the declaration of the entity it starts at, as
  // its next sibling. One whose source is not an entity of this tree — a line
  // naming its endpoints as strings — has no such place and goes to the end.
  const linesFrom = new Map<Entity, Line[]>();
  const trailing: Line[] = [];
  for (const line of lines) {
    const source = typeof line.source === 'object' && ids.has(line.source) ? line.source : undefined;
    if (!source) {
      trailing.push(line);
      continue;
    }
    const existing = linesFrom.get(source);
    if (existing) existing.push(line);
    else linesFrom.set(source, [line]);
  }

  const out: string[] = [];

  const emit = (entity: Entity, depth: number): void => {
    const pad = INDENT.repeat(depth);
    const children = entity.children.filter(emittable);
    const open = braces && children.length > 0 ? ' {' : '';
    out.push(pad + declarationOf(entity, ids, boundarySides) + open);
    for (const child of children) emit(child, depth + 1);
    if (out.at(-1) === '') out.pop();
    if (open) out.push(`${pad}}`);
    for (const line of linesFrom.get(entity) ?? []) out.push(pad + lineOf(line, ids));
    out.push('');
  };

  out.push('bpmn', '', `layout auto`, '');
  for (const entity of entities.filter(emittable)) emit(entity, 0);
  for (const line of trailing) out.push(lineOf(line, ids));
  if (out.at(-1) === '') out.pop();
  return `${out.join('\n')}\n`;
}

/**
 * Give every entity that needs one a reference id.
 *
 * An entity needs an id when a line names it, or when it has a name worth
 * keeping. Its own name is used when it can be written as a reference and is
 * still free; anything else gets a generated one, and the caption it would have
 * lost is written as an explicit label instead (see `declarationOf`).
 */
function assignIds(entities: Entity[], lines: Line[]): Map<Entity, string> {
  const endpoints = new Set<Entity>();
  for (const line of lines) {
    if (typeof line.source === 'object') endpoints.add(line.source);
    if (typeof line.target === 'object') endpoints.add(line.target);
  }

  // Generated ids have to dodge every name in the model, not just the ones
  // handed out so far: a later entity may be called `n1` itself.
  const reserved = new Set(entities.map((entity) => entity.name).filter(Boolean));
  const taken = new Set<string>();
  const ids = new Map<Entity, string>();
  let next = 0;

  for (const entity of entities) {
    if (isUsableName(entity) && !taken.has(entity.name)) {
      taken.add(entity.name);
      ids.set(entity, entity.name);
      continue;
    }
    if (entity.name === '' && !endpoints.has(entity)) continue;
    let generated: string;
    do {
      generated = `n${++next}`;
    } while (reserved.has(generated) || taken.has(generated));
    taken.add(generated);
    ids.set(entity, generated);
  }

  return ids;
}

/** The keywords that open a declaration, in the order the parser reads them. */
function keywordsOf(entity: Entity): string[] {
  switch (entity.type) {
    case 'pool':
    case 'lane':
    case 'region':
    case 'group':
      return [entity.type];
    case 'text':
      return ['comment'];
    case 'port':
      return ['port'];
    case 'data':
      return ['data', entity.dataType ?? 'object'];
    // Always the full `<kind> gate` form, never the bare or boolean-operator
    // spellings: a bare `gate` would be resolved from the flow graph instead of
    // saying what it is.
    case 'gate':
      return [entity.gateType ?? 'exclusive', 'gate'];
    case 'activity': {
      const words: string[] = [];
      const marker = entity.marker ? MARKER_WORDS[entity.marker] : '';
      if (marker) words.push(marker);
      if (entity.taskType) words.push(entity.taskType);
      words.push(ACTIVITY_WORDS[entity.activityType ?? 'task']);
      return words;
    }
    default: {
      const words: string[] = [];
      if (entity.eventType && entity.eventType !== 'blank') words.push(entity.eventType);
      words.push(...OPERATION_WORDS[entity.eventOperation ?? 'catch']);
      return words;
    }
  }
}

function declarationOf(
  entity: Entity,
  ids: Map<Entity, string>,
  boundarySides: boolean,
): string {
  const id = ids.get(entity) ?? '';
  const parts = keywordsOf(entity);
  if (id) parts.push(id);
  // A side is the trailing token of a declaration, after the id: required on a
  // port, optional on a boundary event, where `auto` is what omitting it means
  // anyway.
  if (entity.type === 'port' && entity.portSide) parts.push(entity.portSide);
  if (
    boundarySides &&
    takesSide(entity) &&
    entity.type === 'event' &&
    entity.boundarySide &&
    entity.boundarySide !== 'auto'
  ) {
    parts.push(entity.boundarySide);
  }

  // The caption is only written when the declaration would not draw it anyway:
  // the name-as-label families draw their id, everything else draws nothing. An
  // entity that had to be renamed therefore states its caption explicitly.
  const caption = entityLabel(entity);
  const drawn = NAME_AS_LABEL_TYPES.has(entity.type) ? id : '';
  if (caption !== drawn) parts.push(quote(caption));

  return parts.join(' ');
}

/**
 * The connector of a line.
 *
 * A slash and an arrowhead share the same slot at each end, so a slash can only
 * be written where the arrow leaves that end bare.
 */
function connectorOf(line: Line): string {
  const head = line.slash === 'start' || line.slash === 'both' ? '/' : '';
  const tail = line.slash === 'end' || line.slash === 'both' ? '/' : '';
  if (line.type === '-->') return `${head}-->`;
  if (line.type === '<--') return `<--${tail}`;
  return `${head}---${tail}`;
}

function lineOf(line: Line, ids: Map<Entity, string>): string {
  const ref = (endpoint: Entity | string): string =>
    typeof endpoint === 'string' ? endpoint : (ids.get(endpoint) ?? endpoint.name);
  const parts = [ref(line.source), connectorOf(line), ref(line.target)];
  if (line.label) parts.push(quote(line.label));
  return parts.join(' ');
}
