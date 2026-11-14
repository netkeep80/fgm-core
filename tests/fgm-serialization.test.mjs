import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  deriveSeed, identifyPackage, parsePackage, preparePackage, serializePackage,
} from "./fgm-serialization-witness.mjs";

const bytes = readFileSync(new URL("./fixtures/c04-panel.fgm.json", import.meta.url));
const fixture = () => JSON.parse(bytes);
const encode = value => Buffer.from(value);
const panel = fixture();

test("канонические байты, идентичность и семя совпадают с эталоном", () => {
  const text = readFileSync(new URL("./fixtures/c04-panel-expected.json", import.meta.url));
  const expected = JSON.parse(text);
  assert.deepEqual(serializePackage(parsePackage(bytes)), bytes);
  assert.deepEqual(identifyPackage(panel), { model: expected.model, package: expected.package });
  assert.equal(deriveSeed(panel, "detail"), expected.detailSeed);
});

test("чтение и повторная запись сохраняют форму, материал и порядок узлов", () => {
  const loaded = parsePackage(serializePackage(parsePackage(bytes)));
  const sample = preparePackage(loaded);
  assert.deepEqual(sample([0, 0, 0]), { value: 0.5, material: null, contributor: null });
  assert.deepEqual(sample([1, 0, 0]), { value: -0.5, material: "metal", contributor: "beam" });
  assert.deepEqual(sample([1, 1, 0]), { value: -0.5, material: "stone", contributor: "wall" });
  assert.deepEqual(sample([3, 0, 0]), { value: 1, material: null, contributor: null });
  const reversedNodes = fixture();
  reversedNodes.model.contributions.find(c => c.id === "wall").field.program.nodes.reverse();
  assert.throws(() => serializePackage(reversedNodes), { message: "E_REFERENCE" });
});

test("перестановка ключей и вкладов сохраняет каноническую запись", () => {
  function reverseKeys(value) {
    if (Array.isArray(value)) return value.map(reverseKeys);
    if (typeof value !== "object" || value === null) return value;
    return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) =>
      [key, reverseKeys(item)]));
  }
  const shuffled = reverseKeys(panel);
  shuffled.model.contributions.reverse();
  assert.deepEqual(serializePackage(parsePackage(encode(JSON.stringify(shuffled, null, 2)))), bytes);
  const signedZero = fixture();
  signedZero.generation.parameters.offset = [-0, 0, 0];
  assert.deepEqual(serializePackage(signedZero), bytes);
});

test("изменения рецепта, формы и семян влияют на соответствующую идентичность", () => {
  const original = identifyPackage(panel);
  const generationOnly = [
    next => { next.generation.version = "1.0.1"; },
    next => { next.generation.algorithm = "variant"; },
    next => { next.generation.parameters.offset[0] = 1; },
    next => { next.generation.resources.fixture = "1".repeat(64); },
  ];
  const semanticsOnly = [
    next => { next.model.contributions[0].priority += 1; },
    next => { next.model.contributions.find(c => c.id === "wall").field.parameters.opening[0] = 0.75; },
    next => { next.model.seed = "2".repeat(64); },
  ];
  for (const change of generationOnly) {
    const next = fixture();
    change(next);
    assert.equal(identifyPackage(next).model, original.model);
    assert.notEqual(identifyPackage(next).package, original.package);
    assert.notEqual(deriveSeed(next, "detail"), deriveSeed(panel, "detail"));
  }
  for (const change of semanticsOnly) {
    const next = fixture();
    change(next);
    assert.notEqual(identifyPackage(next).model, original.model);
    assert.notEqual(identifyPackage(next).package, original.package);
    assert.equal(deriveSeed(next, "detail"), deriveSeed(panel, "detail"));
  }
  assert.notEqual(deriveSeed(panel, "detail"), deriveSeed(panel, "surface"));
});

test("сглаживание и привязка объёма сохраняются при чтении", () => {
  const pkg = fixture();
  const digest = "3".repeat(64);
  pkg.model.volumes = { shape: { format: "fixture", sha256: digest } };
  const volume = {
    op: "program",
    parameters: {},
    program: { version: "fgm-0", nodes: [{ id: "v", op: "volume", source: "shape" }], root: "v" },
  };
  pkg.model.contributions = [{
    id: "blend", material: "stone", priority: 1,
    field: { op: "smooth_union", left: volume, right: volume, width: 0.5,
      allowed: panel.model.contributions.find(c => c.id === "wall").field },
  }];
  const loaded = parsePackage(serializePackage(pkg));
  assert.deepEqual(loaded, pkg);
  let calls = 0;
  const sample = preparePackage(loaded, descriptor => {
    assert.deepEqual(descriptor, { format: "fixture", sha256: digest });
    calls++;
    return ([x]) => x - 1;
  });
  assert.equal(calls, 1);
  assert.deepEqual(sample([1, 1, 0]), { value: -0.125, material: "stone", contributor: "blend" });
  assert.deepEqual(sample([3, 0, 0]), { value: 2, material: null, contributor: null });
  const differentVolume = structuredClone(loaded);
  differentVolume.model.volumes.shape.sha256 = "4".repeat(64);
  assert.notEqual(identifyPackage(differentVolume).model, identifyPackage(loaded).model);
  assert.throws(() => preparePackage(loaded), { message: "E_VOLUME" });
  delete loaded.model.volumes.shape;
  assert.throws(() => serializePackage(loaded), { message: "E_VOLUME" });
});

test("неоднозначный JSON и неподдерживаемые обязательные поля отклоняются", () => {
  for (const text of [
    '{"model":{},"model":{}}',
    '{"model":{"name":1,"\\u006eame":2}}',
    '\uFEFF{}',
    '{,}',
  ]) assert.throws(() => parsePackage(encode(text)), { message: "E_JSON" });
  assert.throws(() => parsePackage(Buffer.from([0xc0, 0xaf])), { message: "E_JSON" });
  const malformed = [
    [next => { next.format = "fgm-package/2"; }, "E_PACKAGE_VERSION"],
    [next => { next.interpreter = "fgm-0/2"; }, "E_PACKAGE_VERSION"],
    [next => { next.model.camera = {}; }, "E_PACKAGE"],
    [next => { next.model.contributions[0].field.op = "unknown"; }, "E_FIELD"],
    [next => { next.model.contributions[0].field.program.nodes[0].op = "unknown"; }, "E_OPERATION"],
    [next => { next.model.contributions[0].id = next.model.contributions[1].id; }, "E_CONTRIBUTION"],
    [next => { next.model.contributions[0].priority = Number.MAX_SAFE_INTEGER + 1; }, "E_CONTRIBUTION"],
    [next => { next.generation.resources.fixture = "C:/game.pck"; }, "E_PACKAGE"],
    [next => { next.generation.parameters.offset[0] = Infinity; }, "E_PACKAGE"],
  ];
  for (const [change, message] of malformed) {
    const next = fixture();
    change(next);
    assert.throws(() => serializePackage(next), { message });
  }
});

test("запись принимает только обычные данные JSON и отклоняет неоднозначные объекты", () => {
  const hidden = fixture();
  Object.defineProperty(hidden.model, "seed", { enumerable: false });
  hidden.model.extra = 0;
  assert.throws(() => serializePackage(hidden), { message: "E_PACKAGE" });
  assert.throws(() => identifyPackage(hidden), { message: "E_PACKAGE" });

  const accessor = fixture();
  Object.defineProperty(accessor.model.contributions[0].field.program.nodes[0], "value", {
    get() { assert.fail("Проверка не должна вызывать геттер"); },
  });
  assert.throws(() => serializePackage(accessor), { message: "E_PACKAGE" });

  const extraProperty = fixture();
  extraProperty.model.contributions.extra = 0;
  assert.throws(() => serializePackage(extraProperty), { message: "E_PACKAGE" });
  const sparse = fixture();
  delete sparse.model.contributions[0];
  assert.throws(() => serializePackage(sparse), { message: "E_PACKAGE" });
  const cyclic = fixture();
  cyclic.model.volumes = cyclic;
  assert.throws(() => serializePackage(cyclic), { message: "E_PACKAGE" });
});
