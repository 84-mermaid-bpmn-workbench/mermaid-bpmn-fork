import { describe, expect, it } from 'vitest';
import type { Entity } from '../src/db.js';
import { bpmnXmlToDomainModel } from '../src/bpmn-to-domain.js';
import { domainToBpmnXml } from '../src/domain-to-xml.js';

const NS = [
  'xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"',
  'xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"',
  'xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"',
  'xmlns:di="http://www.omg.org/spec/DD/20100524/DI"',
].join(' ');

/** A document, with an optional diagram over `plane`. */
const doc = (body: string, di = '', plane = 'Process_1'): string =>
  `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions ${NS} id="D" targetNamespace="http://bpmn.io/schema/bpmn">
  ${body}
  ${
    di
      ? `<bpmndi:BPMNDiagram id="Dg"><bpmndi:BPMNPlane id="Pl" bpmnElement="${plane}">${di}</bpmndi:BPMNPlane></bpmndi:BPMNDiagram>`
      : ''
  }
</bpmn:definitions>`;

const shape = (
  element: string,
  x: number,
  y: number,
  width = 100,
  height = 80,
  attrs = '',
): string =>
  `<bpmndi:BPMNShape id="${element}_di" bpmnElement="${element}" ${attrs}>` +
  `<dc:Bounds x="${x}" y="${y}" width="${width}" height="${height}" /></bpmndi:BPMNShape>`;

const names = (entities: Entity[]): string[] => entities.map((entity) => entity.name);
const byName = (entities: Entity[], name: string): Entity =>
  entities.find((entity) => entity.name === name)!;

describe('node families', () => {
  const XML = doc(`
    <bpmn:process id="Process_1">
      <bpmn:startEvent id="s" name="Start"><bpmn:messageEventDefinition id="ed" /></bpmn:startEvent>
      <bpmn:userTask id="t" name="Approve" />
      <bpmn:exclusiveGateway id="g" />
      <bpmn:inclusiveGateway id="g2" name="Or" />
      <bpmn:dataStoreReference id="ds" name="DB" />
      <bpmn:endEvent id="e" />
      <bpmn:textAnnotation id="note"><bpmn:text>hello</bpmn:text></bpmn:textAnnotation>
    </bpmn:process>`);

  it('converts every flow element, artifacts last', async () => {
    const { entities } = await bpmnXmlToDomainModel(XML);
    expect(names(entities)).toEqual(['s', 't', 'g', 'g2', 'ds', 'e', 'note']);
  });

  it('reads an event role and its trigger', async () => {
    const { entities } = await bpmnXmlToDomainModel(XML);
    expect(byName(entities, 's')).toMatchObject({
      type: 'event',
      eventOperation: 'start',
      eventType: 'message',
      label: 'Start',
    });
    // An untyped event leaves eventType unset, the way the parser does.
    expect(byName(entities, 'e').eventType).toBeUndefined();
  });

  it('reads a task glyph off the task element', async () => {
    const { entities } = await bpmnXmlToDomainModel(XML);
    expect(byName(entities, 't')).toMatchObject({
      type: 'activity',
      activityType: 'task',
      taskType: 'user',
      label: 'Approve',
    });
  });

  it('leaves a default gateway kind unset', async () => {
    const { entities } = await bpmnXmlToDomainModel(XML);
    expect(byName(entities, 'g').gateType).toBeUndefined();
    expect(byName(entities, 'g2').gateType).toBe('inclusive');
  });

  it('reads a data store and a text annotation', async () => {
    const { entities } = await bpmnXmlToDomainModel(XML);
    expect(byName(entities, 'ds')).toMatchObject({ type: 'data', dataType: 'store', label: 'DB' });
    expect(byName(entities, 'note')).toMatchObject({ type: 'text', label: 'hello' });
  });

  // The id is the reference name, so a caption equal to it would be noise, and a
  // nameless element has to say "no caption" explicitly — its id is not one.
  it('writes a label only when it differs from the name', async () => {
    const { entities } = await bpmnXmlToDomainModel(
      doc(`<bpmn:process id="Process_1">
             <bpmn:task id="Approve" name="Approve" />
             <bpmn:task id="other" />
           </bpmn:process>`),
    );
    expect(byName(entities, 'Approve').label).toBeUndefined();
    expect(byName(entities, 'other').label).toBe('');
  });

  it('reads activity markers', async () => {
    const { entities } = await bpmnXmlToDomainModel(
      doc(`<bpmn:process id="Process_1">
             <bpmn:task id="a"><bpmn:multiInstanceLoopCharacteristics id="mi" /></bpmn:task>
             <bpmn:task id="b"><bpmn:standardLoopCharacteristics id="sl" /></bpmn:task>
             <bpmn:adHocSubProcess id="c" />
             <bpmn:task id="d" isForCompensation="true" />
           </bpmn:process>`),
    );
    expect(entities.map((entity) => entity.marker)).toEqual([
      'parallel',
      'loop',
      'adhoc',
      'compensation',
    ]);
  });

  it('reads the non-interrupting variants', async () => {
    const { entities } = await bpmnXmlToDomainModel(
      doc(`<bpmn:process id="Process_1">
             <bpmn:subProcess id="sub" triggeredByEvent="true">
               <bpmn:startEvent id="s" isInterrupting="false" />
             </bpmn:subProcess>
           </bpmn:process>`),
    );
    expect(entities[0].activityType).toBe('event-subprocess');
    expect(entities[0].children[0].eventOperation).toBe('non-interrupt');
  });
});

describe('connections', () => {
  it('reads sequence flows with their label and default marker', async () => {
    const { entities, lines } = await bpmnXmlToDomainModel(
      doc(`<bpmn:process id="Process_1">
             <bpmn:exclusiveGateway id="g" default="f1" />
             <bpmn:task id="a" />
             <bpmn:task id="b" />
             <bpmn:sequenceFlow id="f1" sourceRef="g" targetRef="a" />
             <bpmn:sequenceFlow id="f2" sourceRef="g" targetRef="b" name="yes" />
           </bpmn:process>`),
    );
    expect(lines).toHaveLength(2);
    // Endpoints are the entities themselves, so a duplicated or empty name
    // cannot send a line to the wrong node.
    expect(lines[0].source).toBe(byName(entities, 'g'));
    expect(lines[0].target).toBe(byName(entities, 'a'));
    expect(lines[0].slash).toBe('start');
    expect(lines[1]).toMatchObject({ type: '-->', label: 'yes' });
    expect(lines[1].slash).toBeUndefined();
  });

  it('reads an association as an undirected line', async () => {
    const { lines } = await bpmnXmlToDomainModel(
      doc(`<bpmn:process id="Process_1">
             <bpmn:task id="a" />
             <bpmn:textAnnotation id="note"><bpmn:text>why</bpmn:text></bpmn:textAnnotation>
             <bpmn:association id="as" sourceRef="a" targetRef="note" />
           </bpmn:process>`),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].type).toBe('---');
  });

  // A modeller writes the link between a task and a data object inside the task.
  it('reads data associations written inside an activity', async () => {
    const { entities, lines } = await bpmnXmlToDomainModel(
      doc(`<bpmn:process id="Process_1">
             <bpmn:dataObjectReference id="d" dataObjectRef="do" />
             <bpmn:dataObject id="do" isCollection="true" />
             <bpmn:task id="a">
               <bpmn:dataInputAssociation id="in"><bpmn:sourceRef>d</bpmn:sourceRef></bpmn:dataInputAssociation>
             </bpmn:task>
           </bpmn:process>`),
    );
    // The data object itself is never drawn — only the reference to it.
    expect(names(entities)).toEqual(['d', 'a']);
    expect(byName(entities, 'd').dataType).toBe('collection');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ type: '---' });
    expect(lines[0].source).toBe(byName(entities, 'd'));
  });

  it('drops a connection whose endpoint was not drawn', async () => {
    const { lines } = await bpmnXmlToDomainModel(
      doc(`<bpmn:process id="Process_1">
             <bpmn:task id="a" />
             <bpmn:sequenceFlow id="f" sourceRef="a" targetRef="missing" />
           </bpmn:process>`),
    );
    expect(lines).toEqual([]);
  });
});

describe('pools and lanes', () => {
  const XML = doc(`
    <bpmn:collaboration id="C">
      <bpmn:participant id="P1" name="Customer" processRef="Process_1" />
      <bpmn:participant id="P2" name="Vendor" />
      <bpmn:messageFlow id="m" sourceRef="P2" targetRef="t1" name="order" />
    </bpmn:collaboration>
    <bpmn:process id="Process_1">
      <bpmn:laneSet id="ls">
        <bpmn:lane id="L1" name="Sales"><bpmn:flowNodeRef>t1</bpmn:flowNodeRef></bpmn:lane>
        <bpmn:lane id="L2" name="Ops" />
      </bpmn:laneSet>
      <bpmn:task id="t1" name="Take order" />
      <bpmn:task id="t2" />
    </bpmn:process>`);

  it('unpacks a participant into a pool and its lanes into bands', async () => {
    const { entities } = await bpmnXmlToDomainModel(XML);
    expect(names(entities)).toEqual(['P1', 'P2']);
    expect(entities[0].type).toBe('pool');
    expect(entities[0].label).toBe('Customer');
    expect(names(entities[0].children).slice(0, 2)).toEqual(['L1', 'L2']);
    expect(names(entities[0].children[0].children)).toEqual(['t1']);
  });

  // A pool draws bands, not nodes, so anything filed outside every lane needs
  // one of its own.
  it('gives nodes outside every lane a band of their own', async () => {
    const { entities } = await bpmnXmlToDomainModel(XML);
    const spill = entities[0].children[2];
    expect(spill).toMatchObject({ name: '', type: 'lane' });
    expect(names(spill.children)).toEqual(['t2']);
  });

  // A lane lists flow nodes, so an artifact drawn inside one is claimed by
  // nothing and has to be placed by its box.
  it('puts an artifact in the band it is drawn in', async () => {
    const { entities } = await bpmnXmlToDomainModel(
      doc(
        `<bpmn:collaboration id="C">
           <bpmn:participant id="P" name="Pool" processRef="Process_1" />
         </bpmn:collaboration>
         <bpmn:process id="Process_1">
           <bpmn:laneSet id="ls">
             <bpmn:lane id="L1" name="Top"><bpmn:flowNodeRef>a</bpmn:flowNodeRef></bpmn:lane>
             <bpmn:lane id="L2" name="Bottom" />
           </bpmn:laneSet>
           <bpmn:task id="a" />
           <bpmn:textAnnotation id="note"><bpmn:text>why</bpmn:text></bpmn:textAnnotation>
         </bpmn:process>`,
        shape('P', 100, 100, 600, 400) +
          shape('L1', 130, 100, 570, 200) +
          shape('L2', 130, 300, 570, 200) +
          shape('a', 200, 140) +
          shape('note', 200, 340, 100, 30),
        'C',
      ),
    );
    expect(names(entities[0].children)).toEqual(['L1', 'L2']);
    expect(names(entities[0].children[1].children)).toEqual(['note']);
  });

  it('leaves a participant without a process as an empty pool', async () => {
    const { entities } = await bpmnXmlToDomainModel(XML);
    expect(entities[1]).toMatchObject({ name: 'P2', type: 'pool', label: 'Vendor' });
    expect(entities[1].children).toEqual([]);
  });

  it('reads a message flow between a pool and a node', async () => {
    const { entities, lines } = await bpmnXmlToDomainModel(XML);
    expect(lines).toHaveLength(1);
    expect(lines[0].source).toBe(entities[1]);
    expect(lines[0].target).toBe(entities[0].children[0].children[0]);
    expect(lines[0].label).toBe('order');
  });

  // The DSL has no lane inside a lane, so a nested one becomes a band beside
  // its parent and keeps its own members.
  it('flattens nested lanes', async () => {
    const { entities } = await bpmnXmlToDomainModel(
      doc(`<bpmn:process id="Process_1">
             <bpmn:laneSet id="ls">
               <bpmn:lane id="L1" name="Outer">
                 <bpmn:flowNodeRef>a</bpmn:flowNodeRef>
                 <bpmn:childLaneSet id="cs">
                   <bpmn:lane id="L2" name="Inner"><bpmn:flowNodeRef>b</bpmn:flowNodeRef></bpmn:lane>
                 </bpmn:childLaneSet>
               </bpmn:lane>
             </bpmn:laneSet>
             <bpmn:task id="a" />
             <bpmn:task id="b" />
           </bpmn:process>`),
    );
    expect(names(entities)).toEqual(['L1', 'L2']);
    expect(names(entities[0].children)).toEqual(['a']);
    expect(names(entities[1].children)).toEqual(['b']);
  });
});

describe('boundary events', () => {
  it('moves a boundary event into the activity it is attached to', async () => {
    const { entities } = await bpmnXmlToDomainModel(
      doc(`<bpmn:process id="Process_1">
             <bpmn:task id="a" />
             <bpmn:boundaryEvent id="be" attachedToRef="a" cancelActivity="false">
               <bpmn:timerEventDefinition id="td" />
             </bpmn:boundaryEvent>
           </bpmn:process>`),
    );
    expect(names(entities)).toEqual(['a']);
    expect(entities[0].children[0]).toMatchObject({
      name: 'be',
      type: 'event',
      eventOperation: 'boundary-non-interrupt',
      eventType: 'timer',
    });
  });

  it('takes the side it is pinned to from the drawn boxes', async () => {
    const { entities } = await bpmnXmlToDomainModel(
      doc(
        `<bpmn:process id="Process_1">
           <bpmn:task id="a" />
           <bpmn:boundaryEvent id="be" attachedToRef="a" />
         </bpmn:process>`,
        shape('a', 100, 100) + shape('be', 170, 162, 36, 36),
      ),
    );
    expect(entities[0].children[0].boundarySide).toBe('s');
  });

  it('leaves a boundary event with no host where it was found', async () => {
    const { entities } = await bpmnXmlToDomainModel(
      doc(`<bpmn:process id="Process_1"><bpmn:boundaryEvent id="be" /></bpmn:process>`),
    );
    expect(names(entities)).toEqual(['be']);
  });
});

describe('sub-processes', () => {
  const NESTED = `<bpmn:process id="Process_1">
      <bpmn:subProcess id="sub"><bpmn:task id="inner" /></bpmn:subProcess>
    </bpmn:process>`;

  it('nests the contents of an expanded sub-process', async () => {
    const { entities } = await bpmnXmlToDomainModel(
      doc(NESTED, shape('sub', 100, 100, 350, 200, 'isExpanded="true"') + shape('inner', 150, 140)),
    );
    expect(names(entities[0].children)).toEqual(['inner']);
  });

  // A collapsed sub-process still carries its contents in the document, but
  // nothing of them is drawn.
  it('drops the contents of a collapsed sub-process', async () => {
    const { entities } = await bpmnXmlToDomainModel(doc(NESTED, shape('sub', 100, 100)));
    expect(entities[0].children).toEqual([]);
  });

  it('expands every sub-process when the document has no diagram', async () => {
    const { entities } = await bpmnXmlToDomainModel(doc(NESTED));
    expect(names(entities[0].children)).toEqual(['inner']);
  });
});

describe('groups', () => {
  it('claims the nodes its box is drawn over', async () => {
    const { entities } = await bpmnXmlToDomainModel(
      doc(
        `<bpmn:process id="Process_1">
           <bpmn:task id="b" />
           <bpmn:task id="a" />
           <bpmn:task id="outside" />
           <bpmn:group id="G" categoryValueRef="cv" />
         </bpmn:process>
         <bpmn:category id="cat"><bpmn:categoryValue id="cv" value="Box" /></bpmn:category>`,
        shape('a', 100, 100) +
          shape('b', 300, 100) +
          shape('outside', 700, 100) +
          shape('G', 80, 60, 350, 160),
      ),
    );
    expect(names(entities)).toEqual(['G', 'outside']);
    expect(entities[0].label).toBe('Box');
    // and in the order they are drawn in, not the order they were written
    expect(names(entities[0].children)).toEqual(['a', 'b']);
  });

  // What this project's own exporter writes: membership stated by the members.
  it('honours category references over the boxes', async () => {
    const { entities } = await bpmnXmlToDomainModel(
      doc(
        `<bpmn:process id="Process_1">
           <bpmn:task id="a"><bpmn:categoryValueRef>cv</bpmn:categoryValueRef></bpmn:task>
           <bpmn:task id="b" />
           <bpmn:group id="G" categoryValueRef="cv" />
         </bpmn:process>
         <bpmn:category id="cat"><bpmn:categoryValue id="cv" value="Box" /></bpmn:category>`,
        shape('a', 100, 100) + shape('b', 300, 100) + shape('G', 80, 60, 350, 160),
      ),
    );
    expect(names(entities)).toEqual(['G', 'b']);
    expect(names(entities[0].children)).toEqual(['a']);
  });

  it('nests a group drawn inside another group', async () => {
    const { entities } = await bpmnXmlToDomainModel(
      doc(
        `<bpmn:process id="Process_1">
           <bpmn:task id="a" />
           <bpmn:group id="Inner" />
           <bpmn:group id="Outer" />
         </bpmn:process>`,
        shape('a', 120, 120) + shape('Inner', 100, 100, 200, 140) + shape('Outer', 80, 80, 300, 200),
      ),
    );
    expect(names(entities)).toEqual(['Outer']);
    expect(names(entities[0].children)).toEqual(['Inner']);
    expect(names(entities[0].children[0].children)).toEqual(['a']);
  });
});

describe('reading order', () => {
  it('sorts a wide band along the flow', async () => {
    const { entities } = await bpmnXmlToDomainModel(
      doc(
        `<bpmn:process id="Process_1">
           <bpmn:task id="c" /><bpmn:task id="a" /><bpmn:task id="b" />
         </bpmn:process>`,
        shape('c', 500, 100) + shape('a', 100, 100) + shape('b', 300, 100),
      ),
    );
    expect(names(entities)).toEqual(['a', 'b', 'c']);
  });

  it('sorts a tall column downwards', async () => {
    const { entities } = await bpmnXmlToDomainModel(
      doc(
        `<bpmn:process id="Process_1">
           <bpmn:task id="c" /><bpmn:task id="a" /><bpmn:task id="b" />
         </bpmn:process>`,
        shape('c', 100, 500) + shape('a', 100, 100) + shape('b', 100, 300),
      ),
    );
    expect(names(entities)).toEqual(['a', 'b', 'c']);
  });

  it('orders branches that share a column by the other axis', async () => {
    const { entities } = await bpmnXmlToDomainModel(
      doc(
        `<bpmn:process id="Process_1">
           <bpmn:task id="low" /><bpmn:task id="high" /><bpmn:task id="first" />
         </bpmn:process>`,
        shape('low', 300, 300) + shape('high', 300, 100) + shape('first', 100, 200),
      ),
    );
    expect(names(entities)).toEqual(['first', 'high', 'low']);
  });

  it('keeps elements with no shape in document order, at the end', async () => {
    const { entities } = await bpmnXmlToDomainModel(
      doc(
        `<bpmn:process id="Process_1">
           <bpmn:task id="undrawn" /><bpmn:task id="b" /><bpmn:task id="a" />
         </bpmn:process>`,
        shape('a', 100, 100) + shape('b', 300, 100),
      ),
    );
    expect(names(entities)).toEqual(['a', 'b', 'undrawn']);
  });
});

describe('round trip through the exporter', () => {
  const pool = (name: string, children: Entity[]): Entity => ({
    name,
    type: 'pool',
    children,
  });
  const lane = (name: string, children: Entity[]): Entity => ({ name, type: 'lane', children });
  const task = (name: string, extra: Partial<Entity> = {}): Entity => ({
    name,
    type: 'activity',
    activityType: 'task',
    children: [],
    ...extra,
  });

  it('brings a pool, its bands and their nodes back', async () => {
    const boundary: Entity = {
      name: 'be',
      type: 'event',
      children: [],
      eventOperation: 'boundary',
      eventType: 'error',
    };
    const host = task('a', { taskType: 'service' });
    host.children.push(boundary);
    const sub: Entity = {
      name: 'sub',
      type: 'activity',
      activityType: 'subprocess',
      children: [task('deep')],
    };
    const entities = [pool('P', [lane('L', [host, sub])])];
    const { xml } = await domainToBpmnXml(entities, [
      { source: host, target: sub, type: '-->', label: 'next' },
    ]);

    const model = await bpmnXmlToDomainModel(xml);
    expect(names(model.entities)).toEqual(['P']);
    const band = model.entities[0].children[0];
    expect(band.name).toBe('L');
    expect(names(band.children)).toEqual(['a', 'sub']);
    expect(band.children[0]).toMatchObject({ taskType: 'service' });
    expect(band.children[0].children[0]).toMatchObject({
      name: 'be',
      eventOperation: 'boundary',
      eventType: 'error',
    });
    expect(names(band.children[1].children)).toEqual(['deep']);
    expect(model.lines).toHaveLength(1);
    expect(model.lines[0]).toMatchObject({ type: '-->', label: 'next' });
    expect(model.lines[0].source).toBe(band.children[0]);
  });

  it('drops the wrapper participant the exporter adds for pool-less content', async () => {
    const entities = [pool('P', [lane('L', [task('a')])]), task('loose')];
    const { xml } = await domainToBpmnXml(entities, []);
    const model = await bpmnXmlToDomainModel(xml);
    expect(names(model.entities)).toEqual(['P', 'loose']);
  });
});
