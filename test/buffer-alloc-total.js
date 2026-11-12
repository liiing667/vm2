'use strict';

/**
 * bufferAllocTotalLimit — per-run cumulative allocation budget
 *
 * ## Gap
 * `bufferAllocLimit` (GHSA-6785-pvv7-mvg7) caps each INDIVIDUAL allocation,
 * but a script can create many buffers each just under that cap and
 * accumulate unbounded host RSS within a single run:
 *
 *   const keep = [];
 *   for (;;) keep.push(Buffer.alloc(CAP - 1)); // every call passes the cap
 *
 * ## Fix
 * New `bufferAllocTotalLimit` VM/NodeVM option (default `Infinity` — fully
 * backwards-compatible). Every sandbox-facing Buffer / Uint8Array /
 * ArrayBuffer / WebAssembly.Memory allocation path charges one shared
 * per-run ledger (`chargeBufferAlloc` in lib/setup-sandbox.js); exceeding
 * the budget throws a `RangeError` synchronously, before the host
 * allocation happens. The ledger resets on every top-level `run()`.
 */

const assert = require('assert');
const { VM, NodeVM } = require('../lib/main.js');

const HAS_WASM_MEMORY = typeof WebAssembly !== 'undefined' && typeof WebAssembly.Memory === 'function';

if (typeof it.cond !== 'function') {
	it.cond = function (name, cond, fn) {
		return cond ? it(name, fn) : it.skip(name, fn);
	};
}

describe('bufferAllocTotalLimit (per-run cumulative allocation budget)', function () {
	describe('cumulative enforcement', function () {
		it('many under-cap Buffer.alloc calls trip the cumulative budget', function () {
			const vm = new VM({ bufferAllocTotalLimit: 4096 });
			assert.throws(function () {
				vm.run('const k = []; for (let i = 0; i < 10; i++) k.push(Buffer.alloc(1024))');
			}, /^RangeError: Cumulative buffer allocation 5120 exceeds bufferAllocTotalLimit 4096$/);
		});

		it('throws a RangeError synchronously', function () {
			const vm = new VM({ bufferAllocTotalLimit: 10 });
			assert.throws(function () {
				vm.run('Buffer.alloc(8); Buffer.alloc(8)');
			}, RangeError);
		});

		it('the failed charge is not counted and the budget is exact', function () {
			const vm = new VM({ bufferAllocTotalLimit: 4096 });
			// Exactly at the budget: allowed.
			vm.run('const k = []; for (let i = 0; i < 4; i++) k.push(Buffer.alloc(1024))');
			// One byte over in the same run: throws.
			const vm2 = new VM({ bufferAllocTotalLimit: 4096 });
			assert.throws(function () {
				vm2.run('const k = []; for (let i = 0; i < 4; i++) k.push(Buffer.alloc(1024)); k.push(Buffer.alloc(1))');
			}, /exceeds bufferAllocTotalLimit 4096/);
		});

		it('charges every allocation path into one shared ledger', function () {
			const vm = new VM({ bufferAllocTotalLimit: 4096 });
			assert.throws(function () {
				vm.run('Buffer.alloc(2000); new Uint8Array(2000); new ArrayBuffer(200)');
			}, /Cumulative buffer allocation 4200 exceeds bufferAllocTotalLimit 4096/);
		});

		it('charges Buffer.concat against the cumulative budget', function () {
			const vm = new VM({ bufferAllocTotalLimit: 100 });
			assert.throws(function () {
				vm.run('Buffer.concat([Buffer.alloc(60), Buffer.alloc(60)])');
			}, /exceeds bufferAllocTotalLimit 100/);
		});

		it('charges Buffer.from(arrayLike) against the cumulative budget', function () {
			const vm = new VM({ bufferAllocTotalLimit: 100 });
			assert.throws(function () {
				vm.run('Buffer.from({length: 200})');
			}, /exceeds bufferAllocTotalLimit 100/);
		});

		it.cond('charges WebAssembly.Memory initial and grow (delta only)', HAS_WASM_MEMORY, function () {
			const vm = new VM({ bufferAllocTotalLimit: 3 * 65536 });
			assert.throws(function () {
				vm.run('const m = new WebAssembly.Memory({initial: 2}); m.grow(2)');
			}, /exceeds bufferAllocTotalLimit/);
			// initial 2 pages + grow 1 page = exactly the budget: allowed.
			const vm2 = new VM({ bufferAllocTotalLimit: 3 * 65536 });
			vm2.run('const m = new WebAssembly.Memory({initial: 2}); m.grow(1)');
		});
	});

	describe('per-run reset', function () {
		it('the ledger resets on every run()', function () {
			const vm = new VM({ bufferAllocTotalLimit: 4096 });
			// Each run allocates 4000 bytes — under the budget per run, far
			// over it cumulatively. Every run must succeed independently.
			for (let i = 0; i < 5; i++) {
				vm.run('globalThis.b = Buffer.alloc(4000)');
			}
		});

		it('a run that threw still resets the ledger for the next run', function () {
			const vm = new VM({ bufferAllocTotalLimit: 4096 });
			assert.throws(function () {
				vm.run('const k = []; for (let i = 0; i < 10; i++) k.push(Buffer.alloc(1024))');
			}, /exceeds bufferAllocTotalLimit/);
			vm.run('globalThis.b = Buffer.alloc(4000)');
		});
	});

	describe('backwards compatibility', function () {
		it('default (Infinity) budget leaves repeated allocations unrestricted', function () {
			const vm = new VM();
			vm.run('const k = []; for (let i = 0; i < 1000; i++) k.push(Buffer.alloc(1024))');
		});

		it('default (Infinity) budget leaves typed-array allocations unrestricted', function () {
			const vm = new VM();
			const n = vm.run('const k = []; for (let i = 0; i < 100; i++) k.push(new Uint8Array(1024)); k.length');
			assert.strictEqual(n, 100);
		});

		it('single-shot bufferAllocLimit is unchanged when a total budget is also set', function () {
			const vm = new VM({ bufferAllocLimit: 100, bufferAllocTotalLimit: 1024 * 1024 });
			assert.throws(function () {
				vm.run('Buffer.alloc(200)');
			}, /Buffer allocation size 200 exceeds bufferAllocLimit 100/);
		});

		it('finite bufferAllocLimit alone (no total budget) behaves as before', function () {
			const vm = new VM({ bufferAllocLimit: 1024 });
			// Repeated under-cap allocations remain allowed without an
			// explicit cumulative budget.
			vm.run('const k = []; for (let i = 0; i < 100; i++) k.push(Buffer.alloc(1000))');
			assert.throws(function () {
				vm.run('Buffer.alloc(2000)');
			}, /exceeds bufferAllocLimit 1024/);
		});

		it('rejects invalid bufferAllocTotalLimit values at construction', function () {
			assert.throws(function () {
				void new VM({ bufferAllocTotalLimit: -1 });
			}, /bufferAllocTotalLimit must be a non-negative number/);
			assert.throws(function () {
				void new VM({ bufferAllocTotalLimit: NaN });
			}, /bufferAllocTotalLimit must be a non-negative number/);
			assert.throws(function () {
				void new VM({ bufferAllocTotalLimit: '1024' });
			}, /bufferAllocTotalLimit must be a non-negative number/);
		});
	});

	describe('NodeVM', function () {
		it('enforces the cumulative budget', function () {
			const vm = new NodeVM({ bufferAllocTotalLimit: 4096 });
			assert.throws(function () {
				vm.run('const k = []; for (let i = 0; i < 10; i++) k.push(Buffer.alloc(1024)); module.exports = 1');
			}, /^RangeError: Cumulative buffer allocation 5120 exceeds bufferAllocTotalLimit 4096$/);
		});

		it('resets the ledger per run', function () {
			const vm = new NodeVM({ bufferAllocTotalLimit: 4096 });
			vm.run('globalThis.b = Buffer.alloc(4000); module.exports = 1');
			vm.run('globalThis.c = Buffer.alloc(4000); module.exports = 2');
		});

		it('defaults to Infinity (unrestricted)', function () {
			const vm = new NodeVM();
			vm.run('const k = []; for (let i = 0; i < 1000; i++) k.push(Buffer.alloc(1024)); module.exports = 1');
		});
	});
});
