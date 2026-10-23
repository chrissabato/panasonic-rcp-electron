const test = require('node:test');
const assert = require('node:assert/strict');
const { CommandQueue } = require('../src/main/camera/commandQueue');

const deferred = () => {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
};

test('jobs on one channel run one at a time, in order', async () => {
    const queue = new CommandQueue();
    const order = [];
    let running = 0;
    const job = (name) => async () => {
        running++;
        assert.equal(running, 1);
        await new Promise((r) => setTimeout(r, 5));
        order.push(name);
        running--;
        return name;
    };

    const results = await Promise.all([queue.enqueue(1, 'a', job('a')), queue.enqueue(1, 'b', job('b')), queue.enqueue(1, null, job('c'))]);
    assert.deepEqual(results, ['a', 'b', 'c']);
    assert.deepEqual(order, ['a', 'b', 'c']);
});

test('a waiting job is replaced by a newer one with the same key', async () => {
    const queue = new CommandQueue();
    const gate = deferred();
    const sent = [];

    const first = queue.enqueue(1, 'iris', async () => { await gate.promise; sent.push(10); return 10; });
    const second = queue.enqueue(1, 'iris', async () => { sent.push(20); return 20; });
    const third = queue.enqueue(1, 'iris', async () => { sent.push(30); return 30; });
    gate.resolve();

    assert.deepEqual(await Promise.all([first, second, third]), [10, 30, 30]);
    assert.deepEqual(sent, [10, 30]);
});

test('channels run independently', async () => {
    const queue = new CommandQueue();
    const gate = deferred();
    const blocked = queue.enqueue(1, 'x', () => gate.promise);
    assert.equal(await queue.enqueue(2, 'x', async () => 'ch2'), 'ch2');
    gate.resolve('ch1');
    assert.equal(await blocked, 'ch1');
});

test('a throwing job rejects its callers and the queue keeps going', async () => {
    const queue = new CommandQueue();
    await assert.rejects(queue.enqueue(1, 'a', async () => { throw new Error('boom'); }), /boom/);
    assert.equal(await queue.enqueue(1, 'b', async () => 'ok'), 'ok');
});
