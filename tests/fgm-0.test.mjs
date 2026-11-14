import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { prepareFgm0 } from "./fgm-0-witness.mjs";

function program(nodes, root = nodes.at(-1).id) {
  return { version: "fgm-0", nodes, root };
}

function constant(id, type, value) {
  return { id, op: "constant", type, value };
}

const radius = constant("r", "length", 2);
const ball = { id: "ball", op: "sphere", radius: "r" };

function pairedBoxes(op, offset = 3) {
  return program([
    constant("size", "vec3", [2, 1, 1]),
    { id: "a", op: "box", halfSize: "size" },
    constant("offset", "vec3", [offset, 0, 0]),
    { id: "b", op: "translate", field: "a", offset: "offset" },
    { id: "shape", op, left: "a", right: "b" },
  ]);
}

test("пример перенесённой сферы из спецификации выполняется", () => {
  const spec = readFileSync(new URL("../docs/fgm-0.md", import.meta.url), "utf8");
  const example = spec.match(/^~~~json\r?\n([\s\S]*?)\r?\n~~~$/m);
  assert.ok(example, "В спецификации должен быть пример программы в JSON");
  const sample = prepareFgm0(JSON.parse(example[1]));
  assert.deepEqual(sample([3, 0, 0]), { value: -2 });
  assert.deepEqual(sample([5, 0, 0]), { value: 0 });
  assert.deepEqual(sample([6, 0, 0]), { value: 1 });
});

test("сфера использует длину радиус-вектора и явный параметр", () => {
  const sample = prepareFgm0(program([
    { id: "r", op: "parameter", type: "length" },
    ball,
  ]), { parameters: { r: 2 } });
  assert.deepEqual(sample([3, 4, 0]), { value: 3 });
  assert.deepEqual(sample([0, 2, 0]), { value: 0 });
});

test("параллелепипед использует три полуразмера", () => {
  const size = [1, 2, 3];
  const sample = prepareFgm0(program([
    { id: "size", op: "parameter", type: "vec3" },
    { id: "shape", op: "box", halfSize: "size" },
  ]), { parameters: { size } });
  size[0] = 7;
  assert.deepEqual(sample([0, 0, 0]), { value: -1 });
  assert.deepEqual(sample([1, 2, 3]), { value: 0 });
  assert.deepEqual(sample([0, 3, 0]), { value: 1 });
});

test("объединение даёт одно поле на границе двух кубических областей", () => {
  const sample = prepareFgm0(pairedBoxes("union"));
  const fromLeft = sample([0.5 + 1, 0.25, 0]);
  assert.deepEqual(sample([-2, 0, 0]), { value: 0 });
  assert.deepEqual(sample([6, 0, 0]), { value: 1 });
  const fromRight = sample([1.5 + 0, 0.25, 0]);
  assert.deepEqual(fromLeft, { value: -0.5 });
  assert.deepEqual(fromRight, fromLeft);
});

test("пересечение сохраняет только общую внутреннюю область", () => {
  const sample = prepareFgm0(pairedBoxes("intersection"));
  assert.deepEqual(sample([0, 0, 0]), { value: 1 });
  assert.deepEqual(sample([1.5, 0, 0]), { value: -0.5 });
  assert.deepEqual(sample([2, 0, 0]), { value: 0 });
});

test("касание параллелепипедов оставляет нулевое поле внутри стыка", () => {
  const sample = prepareFgm0(pairedBoxes("union", 4));
  assert.deepEqual(sample([1.75, 0, 0]), { value: -0.25 });
  assert.deepEqual(sample([2, 0, 0]), { value: 0 });
  assert.deepEqual(sample([2.25, 0, 0]), { value: -0.25 });
});

test("вычитание оставляет сквозной проём и материал вокруг него", () => {
  const sample = prepareFgm0(program([
    constant("outer_size", "vec3", [2, 2, 1]),
    { id: "outer", op: "box", halfSize: "outer_size" },
    constant("hole_size", "vec3", [0.5, 0.5, 2]),
    { id: "hole", op: "box", halfSize: "hole_size" },
    { id: "shape", op: "subtract", left: "outer", right: "hole" },
  ]));
  for (const z of [-1, 0, 1]) {
    assert.deepEqual(sample([0, 0, z]), { value: 0.5 });
  }
  assert.deepEqual(sample([0.5, 0, 0]), { value: 0 });
  assert.deepEqual(sample([1, 0, 0]), { value: -0.5 });
});

test("вычитание поля из самого себя даёт модуль поля", () => {
  const sample = prepareFgm0(program([
    radius, ball,
    { id: "shape", op: "subtract", left: "ball", right: "ball" },
  ]));
  assert.deepEqual(sample([0, 0, 0]), { value: 2 });
  assert.deepEqual(sample([2, 0, 0]), { value: 0 });
  assert.deepEqual(sample([3, 0, 0]), { value: 1 });
});

test("материал сохраняет значение привязанного объёмного поля", () => {
  const sample = prepareFgm0(program([
    { id: "shape", op: "volume", source: "layer" },
    { id: "body", op: "material", field: "shape", kind: "metal" },
  ]), { volumes: { layer: ([x]) => x - 2 } });
  assert.deepEqual(sample([1, 0, 0]), { value: -1, material: "metal" });
  assert.deepEqual(sample([3, 0, 0]), { value: 1, material: "metal" });
});

const invalidPrograms = [
  ["лишнее поле камеры", "E_PROGRAM", { ...program([radius, ball]), camera: {} }],
  ["неизвестная версия", "E_VERSION", { ...program([radius, ball]), version: "fgm-1" }],
  ["лишнее поле узла", "E_NODE", program([radius, { ...ball, lod: 2 }])],
  ["повтор идентификатора", "E_DUPLICATE", program([radius, radius, ball])],
  ["неизвестная операция", "E_OPERATION", program([{ id: "shape", op: "unknown" }])],
  ["ссылка вперёд", "E_REFERENCE", program([ball, radius], "ball")],
  ["отсутствующий корень", "E_REFERENCE", program([radius, ball], "missing")],
  ["скаляр на месте корня", "E_TYPE", program([radius])],
  ["вектор на месте радиуса", "E_TYPE", program([constant("r", "vec3", [2, 2, 2]), ball])],
  ["нулевой радиус", "E_VALUE", program([constant("r", "length", 0), ball])],
  ["неконечный литерал", "E_VALUE", program([constant("r", "length", Infinity), ball])],
  ["неверная структура привязок", "E_BINDINGS", program([radius, ball]), null],
  ["камера в привязках", "E_BINDINGS", program([radius, ball]), { camera: {} }],
  ["параметр не передан", "E_PARAMETER", program([{ id: "r", op: "parameter", type: "length" }, ball])],
  ["лишний параметр", "E_PARAMETER", program([radius, ball]), { parameters: { r: 2 } }],
  ["нет снимка объёмного поля", "E_VOLUME", program([{ id: "v", op: "volume", source: "missing" }])],
];

for (const [name, code, fixture, bindings] of invalidPrograms) {
  test(`отказ при проверке программы — ${name}`, () => {
    assert.throws(() => prepareFgm0(fixture, bindings), { message: code });
  });
}

test("отказ при выборке точки с неверной координатой", () => {
  const sample = prepareFgm0(program([radius, ball]));
  assert.throws(() => sample([0, NaN, 0]), { message: "E_VALUE" });
});

test("отказ при переполнении координаты после переноса", () => {
  const sample = prepareFgm0(program([
    radius, ball,
    constant("offset", "vec3", [-Number.MAX_VALUE, 0, 0]),
    { id: "shape", op: "translate", field: "ball", offset: "offset" },
  ]));
  assert.throws(() => sample([Number.MAX_VALUE, 0, 0]), { message: "E_NUMERIC" });
});
