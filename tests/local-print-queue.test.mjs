import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LocalPrintQueue } from '../dist/lib/localPrintQueue.js';

function fixture(options = {}) {
  const jobs = options.jobs || [{ id: 'one', state: 'queued', topic: 'noor/orders/placed/a', storeId: 'noor', payload: {}, createdAt: new Date() }];
  let writes = 0;
  const repo = {
    queued: async () => jobs.filter(job => job.state === 'queued').map(job => ({ ...job })),
    claim: async id => { const job = jobs.find(job => job.id === id); if (job.state !== 'queued') return false; job.state = 'uncertain'; return true; },
    delivered: async id => { if (options.failCommit) throw new Error('Database connection lost after writing'); jobs.find(job => job.id === id).state = 'delivered'; },
    error: async (id, error) => { jobs.find(job => job.id === id).error = error; },
  };
  const writer = async job => {
    assert.equal(jobs.find(saved => saved.id === job.id).state, 'uncertain', 'persist uncertainty before device I/O');
    writes++;
    if (options.write) await options.write(job);
    if (options.failWrite) throw new Error('Serial write stopped after partial bytes');
  };
  const route = topic => options.noRoute ? undefined : ({ device: topic.endsWith('/b') ? '/dev/rfcomm1' : '/dev/rfcomm0' });
  return { jobs, repo, writer, route, get writes() { return writes; },
    queue: new LocalPrintQueue(repo, route, writer, async () => !options.deviceMissing) };
}

test('competing dispatchers claim one durable ticket exactly once', async () => {
  const f = fixture();
  const other = new LocalPrintQueue(f.repo, f.route, f.writer, async () => true);
  await Promise.all([f.queue.tick(), other.tick()]);
  assert.equal(f.writes, 1);
  assert.equal(f.jobs[0].state, 'delivered');
});

test('partial writes remain uncertain through worker restart', async () => {
  const f = fixture({ failWrite: true });
  await f.queue.tick();
  assert.equal(f.jobs[0].state, 'uncertain');
  assert.match(f.jobs[0].error, /partial/);
  const restarted = new LocalPrintQueue(f.repo, f.route, f.writer, async () => true);
  await restarted.tick();
  assert.equal(f.writes, 1);
});

test('lost database acknowledgement after successful write never replays the receipt', async () => {
  const f = fixture({ failCommit: true });
  await f.queue.tick();
  await f.queue.tick();
  assert.equal(f.writes, 1);
  assert.equal(f.jobs[0].state, 'uncertain');
});

test('known unavailable devices remain queued without risking paper', async () => {
  for (const options of [{ noRoute: true }, { deviceMissing: true }]) {
    const f = fixture(options);
    await f.queue.tick();
    assert.equal(f.writes, 0);
    assert.equal(f.jobs[0].state, 'queued');
    assert.match(f.jobs[0].error, /not been sent/);
  }
});

test('same device is serialized while separate printers can write concurrently', async () => {
  const jobs = ['a', 'a', 'b'].map((suffix, i) => ({ id: String(i), state: 'queued', topic: `noor/orders/placed/${suffix}`, storeId: 'noor', payload: {}, createdAt: new Date() }));
  const active = new Set();
  let concurrent = false;
  const f = fixture({ jobs, write: async job => {
    assert.equal(active.has(job.topic), false);
    active.add(job.topic); concurrent ||= active.size === 2;
    await new Promise(resolve => setTimeout(resolve, 10));
    active.delete(job.topic);
  } });
  await f.queue.tick();
  assert.equal(f.writes, 2);
  assert.ok(concurrent);
  await f.queue.tick();
  assert.equal(f.writes, 3);
  assert.ok(f.jobs.every(job => job.state === 'delivered'));
});

test('older preparation tickets are not starved by newer arrival tickets on the same device', async () => {
  const f = fixture({ jobs: [
    { id: 'arrival', state: 'queued', topic: 'noor/orders/placed/a', storeId: 'noor', payload: {}, createdAt: new Date(2000) },
    { id: 'preparing', state: 'queued', topic: 'noor/orders/preparing/a', storeId: 'noor', payload: {}, createdAt: new Date(1000) },
  ] });
  await f.queue.tick();
  assert.equal(f.jobs.find(job => job.id === 'preparing').state, 'delivered');
  assert.equal(f.jobs.find(job => job.id === 'arrival').state, 'queued');
});
