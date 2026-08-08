import { beforeEach, describe, expect, it } from 'vitest';
import { db, entityLabel, type Entity, type Line } from '../src/db.js';
import { domainToSource } from '../src/domain-to-source.js';
import { bpmnXmlToDomainModel } from '../src/bpmn-to-domain.js';
import { parser } from '../src/parser.js';

const task = (name: string, extra: Partial<Entity> = {}): Entity => ({
  name,
  type: 'activity',
  activityType: 'task',
  children: [],
  ...extra,
});

/** The body of a generated source: everything after `bpmn` / `layout auto`. */
const body = (
  entities: Entity[],
  lines: Line[] = [],
  braces = false,
  boundarySides = false,
): string[] => domainToSource(entities, lines, { braces, boundarySides }).split('\n').slice(3, -1);

/** What a declaration says, independent of the ids the writer handed out. */
interface Shape {
  decl: string;
  label: string;
  children: Shape[];
}
const shapeOf = (entity: Entity): Shape => ({
  decl: [
    entity.type,
    entity.activityType,
    entity.taskType,
    entity.marker,
    entity.gateType,
    entity.dataType,
    entity.eventOperation,
    entity.eventType,
  ]
    .filter(Boolean)
    .join(' '),
  label: entityLabel(entity),
  children: entity.children.map(shapeOf),
});

/** A line as `<source caption> <arrow> <target caption>`, plus label and slash. */
const wireOf = (line: Line, index: Map<string, Entity>): string => {
  const end = (endpoint: Entity | string): string => {
    const entity = typeof endpoint === 'string' ? index.get(endpoint) : endpoint;
    return entity ? entityLabel(entity) || entity.name : `?${String(endpoint)}`;
  };
  return [
    end(line.source),
    line.type,
    line.slash ?? '',
    end(line.target),
    line.label ?? '',
  ].join('|');
};

const indexOf = (entities: Entity[], into = new Map<string, Entity>()): Map<string, Entity> => {
  for (const entity of entities) {
    if (entity.name && !into.has(entity.name)) into.set(entity.name, entity);
    indexOf(entity.children, into);
  }
  return into;
};

/** Write, parse, and report what came back — the round trip a test asserts on. */
const roundTrip = (
  entities: Entity[],
  lines: Line[] = [],
  braces = false,
): { shapes: Shape[]; wires: string[] } => {
  db.clear();
  parser.parse(domainToSource(entities, lines, { braces }));
  const parsed = db.getEntities();
  const index = indexOf(parsed);
  return {
    shapes: parsed.map(shapeOf),
    wires: db.getLines().map((line) => wireOf(line, index)),
  };
};

const expected = (entities: Entity[], lines: Line[] = []): { shapes: Shape[]; wires: string[] } => ({
  shapes: entities.map(shapeOf),
  wires: lines.map((line) => wireOf(line, indexOf(entities))),
});

describe('the frame', () => {
  beforeEach(() => db.clear());

  it('opens with the header and the layout directive', () => {
    expect(domainToSource([task('a')], [])).toBe('bpmn\n  layout auto\n\n  task a\n');
  });

  it('wraps the diagram in braces in curly mode', () => {
    expect(domainToSource([task('a')], [], { braces: true })).toBe(
      'bpmn {\n  layout auto\n\n  task a\n}\n',
    );
  });

  it('writes no styling, routing or direction, whatever the model carries', () => {
    const styled: Entity = {
      ...task('a'),
      style: { fill: 'red', stroke: 'blue' },
      classes: ['important'],
      direction: 'TB',
      autoSequence: true,
      children: [task('b')],
    };
    expect(body([styled], [{ source: styled, target: styled.children[0], type: '-->', style: { stroke: 'red' }, routing: { depth: 1 } }])).toEqual([
      '  task a',
      '    task b',
      '  a --> b',
    ]);
  });
});

describe('declarations', () => {
  beforeEach(() => db.clear());

  it('writes the full form of every gateway kind', () => {
    const gates: Entity[] = [
      { name: 'g1', type: 'gate', children: [] },
      { name: 'g2', type: 'gate', children: [], gateType: 'parallel' },
      { name: 'g3', type: 'gate', children: [], gateType: 'inclusive' },
      { name: 'g4', type: 'gate', children: [], gateType: 'event' },
      { name: 'g5', type: 'gate', children: [], gateType: 'complex' },
    ];
    expect(body(gates)).toEqual([
      '  exclusive gate g1',
      '  parallel gate g2',
      '  inclusive gate g3',
      '  event gate g4',
      '  complex gate g5',
    ]);
    expect(roundTrip(gates)).toEqual(expected(gates));
  });

  it('writes an activity as marker, glyph, family', () => {
    const activities: Entity[] = [
      task('a', { taskType: 'user' }),
      task('b', { taskType: 'receive-instance' }),
      task('c', { marker: 'parallel', taskType: 'send' }),
      { name: 'd', type: 'activity', activityType: 'subprocess', marker: 'adhoc', children: [] },
      { name: 'e', type: 'activity', activityType: 'event-subprocess', children: [] },
      { name: 'f', type: 'activity', activityType: 'call', children: [] },
      { name: 'g', type: 'activity', activityType: 'transaction', marker: 'loop', children: [] },
    ];
    expect(body(activities)).toEqual([
      '  user task a',
      '  receive-instance task b',
      '  parallel send task c',
      '  ad-hoc subprocess d',
      '  event-subprocess e',
      '  call f',
      '  loop transaction g',
    ]);
    expect(roundTrip(activities)).toEqual(expected(activities));
  });

  it('writes an event as trigger then role', () => {
    const events: Entity[] = [
      { name: 'a', type: 'event', children: [], eventOperation: 'start', eventType: 'message' },
      { name: 'b', type: 'event', children: [], eventOperation: 'catch', eventType: 'timer' },
      { name: 'c', type: 'event', children: [], eventOperation: 'throw', eventType: 'link' },
      { name: 'd', type: 'event', children: [], eventOperation: 'end', eventType: 'error' },
      { name: 'f', type: 'event', children: [], eventOperation: 'non-interrupt' },
      { name: 'g', type: 'event', children: [], eventOperation: 'catch', eventType: 'parallel' },
    ];
    expect(body(events)).toEqual([
      '  message start a',
      '  timer catch b',
      '  link throw c',
      '  error end d',
      '  non-interrupting f',
      '  parallel catch g',
    ]);
    expect(roundTrip(events)).toEqual(expected(events));
  });

  it('writes a boundary event inside its host, non-interrupting first', () => {
    const boundary: Entity = {
      name: 'be',
      type: 'event',
      children: [],
      eventOperation: 'boundary-non-interrupt',
      eventType: 'timer',
    };
    const host = task('a', { children: [boundary] });
    expect(body([host])).toEqual(['  task a', '    timer non-interrupting boundary be']);
    expect(roundTrip([host])).toEqual(expected([host]));
  });

  // The side is a placement hint, so it is only written when asked for; `auto`
  // is what leaving it out means anyway.
  it('writes the side of a boundary event only with boundarySides', () => {
    const pinned: Entity = {
      name: 'be',
      type: 'event',
      children: [],
      eventOperation: 'boundary',
      eventType: 'error',
      boundarySide: 'e',
    };
    const derived: Entity = { ...pinned, name: 'auto1', boundarySide: 'auto' };
    const host = task('a', { children: [pinned, derived] });

    expect(body([host])).toEqual([
      '  task a',
      '    error boundary be',
      '    error boundary auto1',
    ]);
    expect(body([host], [], false, true)).toEqual([
      '  task a',
      '    error boundary be e',
      '    error boundary auto1',
    ]);
  });

  it('reads the side back off the declaration it wrote', () => {
    const pinned: Entity = {
      name: 'be',
      type: 'event',
      children: [],
      eventOperation: 'boundary-non-interrupt',
      boundarySide: 's',
    };
    const host = task('a', { children: [pinned] });
    db.clear();
    parser.parse(domainToSource([host], [], { boundarySides: true }));
    expect(db.getEntities()[0].children[0]).toMatchObject({ name: 'be', boundarySide: 's' });
  });

  it('writes the containers, data elements and annotations', () => {
    const entities: Entity[] = [
      {
        name: 'P',
        type: 'pool',
        children: [
          {
            name: 'L',
            type: 'lane',
            children: [
              { name: 'd1', type: 'data', children: [] },
              { name: 'd2', type: 'data', children: [], dataType: 'store' },
              { name: 'd3', type: 'data', children: [], dataType: 'collection' },
              { name: 'note', type: 'text', children: [] },
              { name: 'G', type: 'group', children: [] },
              { name: 'R', type: 'region', children: [] },
            ],
          },
        ],
      },
    ];
    expect(body(entities)).toEqual([
      '  pool P',
      '    lane L',
      '      data object d1',
      '      data store d2',
      '      data collection d3',
      '      comment note',
      '      group G',
      '      region R',
    ]);
    expect(roundTrip(entities)).toEqual(expected(entities));
  });
});

describe('names and labels', () => {
  beforeEach(() => db.clear());

  // The id is drawn as the caption for most families, so a matching label would
  // be noise — and a caption that is NOT the id has to be written out.
  it('writes a label only when the declaration would not draw it', () => {
    const entities = [
      task('a', { label: 'a' }),
      task('b', { label: 'Approve' }),
      task('c', { label: '' }),
      { name: 'g', type: 'gate' as const, children: [], label: 'Valid?' },
    ];
    expect(body(entities)).toEqual([
      '  task a',
      '  task b "Approve"',
      '  task c ""',
      '  exclusive gate g "Valid?"',
    ]);
    expect(roundTrip(entities)).toEqual(expected(entities));
  });

  it('escapes quotes, backslashes and line breaks in a label', () => {
    const entities = [task('a', { label: 'say "hi"\nand C:\\tmp' })];
    expect(body(entities)).toEqual(['  task a "say \\"hi\\"\\ and C:\\\\tmp"']);
    expect(roundTrip(entities)).toEqual(expected(entities));
  });

  // A name that cannot be written as a reference is replaced by a generated id,
  // and the caption it carried becomes an explicit label.
  // A name is only a hazard for the families that read a trailing word as a
  // modifier: `lane lr` would set a direction, `task e` is an ordinary id.
  it('renames an entity whose name is not a usable reference', () => {
    const entities: Entity[] = [
      task('Receive Order'),
      { name: 'P', type: 'pool', children: [{ name: 'lr', type: 'lane', children: [] }] },
      { name: 'e', type: 'text', children: [] },
      task('e'),
    ];
    expect(body(entities)).toEqual([
      '  task n1 "Receive Order"',
      '  pool P',
      '    lane n2 "lr"',
      '  comment n3 "e"',
      '  task e',
    ]);
    expect(roundTrip(entities)).toEqual(expected(entities));
  });

  it('keeps generated ids clear of names used elsewhere in the model', () => {
    const entities = [task('Receive Order'), task('n1')];
    expect(body(entities)).toEqual(['  task n2 "Receive Order"', '  task n1']);
  });

  it('gives a nameless entity an id only when a line needs one', () => {
    const anonymous = task('');
    const lane: Entity = { name: '', type: 'lane', children: [anonymous, task('')] };
    expect(body([lane], [{ source: anonymous, target: anonymous, type: '-->' }])).toEqual([
      '  lane',
      '    task n1 ""',
      '    n1 --> n1',
      '    task',
    ]);
  });
});

describe('lines', () => {
  beforeEach(() => db.clear());

  it('writes every line as an absolute line after its source', () => {
    const a = task('a');
    const b = task('b');
    const sub: Entity = { name: 'sub', type: 'activity', activityType: 'subprocess', children: [b] };
    const lines: Line[] = [
      { source: a, target: b, type: '-->', label: 'go' },
      { source: b, target: a, type: '---' },
      { source: sub, target: a, type: '-->' },
    ];
    expect(body([a, sub], lines)).toEqual([
      '  task a',
      '  a --> b "go"',
      '  subprocess sub',
      '    task b',
      '    b --- a',
      '  sub --> a',
    ]);
    expect(roundTrip([a, sub], lines)).toEqual(expected([a, sub], lines));
  });

  it('writes the slash on the end the arrow leaves bare', () => {
    const a = task('a');
    const b = task('b');
    const lines: Line[] = [
      { source: a, target: b, type: '-->', slash: 'start' },
      { source: a, target: b, type: '---', slash: 'end' },
      { source: a, target: b, type: '---', slash: 'both' },
      { source: a, target: b, type: '<--', slash: 'end' },
    ];
    expect(body([a, b], lines)).toEqual([
      '  task a',
      '  a /--> b',
      '  a ---/ b',
      '  a /---/ b',
      '  a <--/ b',
      '  task b',
    ]);
    expect(roundTrip([a, b], lines)).toEqual(expected([a, b], lines));
  });

  it('writes a line whose endpoints are names at the end', () => {
    const a = task('a');
    expect(body([a], [{ source: 'x', target: 'y', type: '-->' }])).toEqual([
      '  task a',
      '  x --> y',
    ]);
  });
});

describe('curly mode', () => {
  beforeEach(() => db.clear());

  const MODEL: Entity[] = [
    {
      name: 'P',
      type: 'pool',
      children: [
        {
          name: 'L',
          type: 'lane',
          children: [
            task('a'),
            {
              name: 'sub',
              type: 'activity',
              activityType: 'subprocess',
              children: [task('b'), task('c')],
            },
          ],
        },
      ],
    },
  ];
  const LINES: Line[] = [{ source: MODEL[0].children[0].children[0], target: 'b', type: '-->' }];

  it('braces every declaration that has children, and nothing else', () => {
    expect(body(MODEL, LINES, true)).toEqual([
      '  pool P {',
      '    lane L {',
      '      task a',
      '      a --> b',
      '      subprocess sub {',
      '        task b',
      '        task c',
      '      }',
      '    }',
      '  }',
      '}',
    ]);
  });

  // The whole point of the flag: same declarations, same order, same indent.
  it('differs from indented output by the braces alone', () => {
    const curly = domainToSource(MODEL, LINES, { braces: true })
      .split('\n')
      .map((line) => line.replace(/ \{$/, ''))
      .filter((line) => !/^\s*\}$/.test(line));
    expect(curly).toEqual(domainToSource(MODEL, LINES).split('\n'));
  });

  it('parses back to the same model as the indented form', () => {
    expect(roundTrip(MODEL, LINES, true)).toEqual(roundTrip(MODEL, LINES));
  });
});

describe('from a BPMN document', () => {
  beforeEach(() => db.clear());

  const XML = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="D" targetNamespace="x">
  <bpmn:collaboration id="C">
    <bpmn:participant id="Insurer" name="Insurer" processRef="Process_1" />
    <bpmn:participant id="Customer" name="Customer" />
    <bpmn:messageFlow id="m" name="claim" sourceRef="Customer" targetRef="Start_1" />
  </bpmn:collaboration>
  <bpmn:process id="Process_1">
    <bpmn:laneSet id="ls">
      <bpmn:lane id="Intake" name="Intake">
        <bpmn:flowNodeRef>Start_1</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>Check</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>Timeout</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>Split</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>Done</bpmn:flowNodeRef>
      </bpmn:lane>
    </bpmn:laneSet>
    <bpmn:startEvent id="Start_1" name="Claim received">
      <bpmn:messageEventDefinition id="ed" />
    </bpmn:startEvent>
    <bpmn:userTask id="Check" name="Check claim" />
    <bpmn:boundaryEvent id="Timeout" name="2 days" cancelActivity="false" attachedToRef="Check">
      <bpmn:timerEventDefinition id="td" />
    </bpmn:boundaryEvent>
    <bpmn:exclusiveGateway id="Split" default="f3" />
    <bpmn:endEvent id="Done" name="Done" />
    <bpmn:sequenceFlow id="f1" sourceRef="Start_1" targetRef="Check" />
    <bpmn:sequenceFlow id="f2" sourceRef="Check" targetRef="Split" name="ok" />
    <bpmn:sequenceFlow id="f3" sourceRef="Split" targetRef="Done" />
  </bpmn:process>
</bpmn:definitions>`;

  it('writes a source the parser reads back into the same model', async () => {
    const model = await bpmnXmlToDomainModel(XML);
    const source = domainToSource(model.entities, model.lines);

    expect(source).toBe(
      [
        'bpmn',
        '  layout auto',
        '',
        '  pool Insurer',
        '    lane Intake',
        '      message start Start_1 "Claim received"',
        '      Start_1 --> Check',
        '      user task Check "Check claim"',
        '        timer non-interrupting boundary Timeout "2 days"',
        '      Check --> Split "ok"',
        '      exclusive gate Split',
        '      Split /--> Done',
        '      end Done',
        '  pool Customer',
        '  Customer --> Start_1 "claim"',
        '',
      ].join('\n'),
    );

    parser.parse(source);
    expect(db.getEntities().map(shapeOf)).toEqual(model.entities.map(shapeOf));
    expect(db.getLines().map((line) => wireOf(line, indexOf(db.getEntities())))).toEqual(
      model.lines.map((line) => wireOf(line, indexOf(model.entities))),
    );
  });

  it('produces the same document in curly mode', async () => {
    const model = await bpmnXmlToDomainModel(XML);
    const curly = domainToSource(model.entities, model.lines, { braces: true })
      .split('\n')
      .map((line) => line.replace(/ \{$/, ''))
      .filter((line) => !/^\s*\}$/.test(line));
    expect(curly).toEqual(domainToSource(model.entities, model.lines).split('\n'));
  });
});
