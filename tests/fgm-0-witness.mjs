// Исполнитель синтетических примеров C01.
const nodeFields = new Map([
  ["constant", ["type", "value"]],
  ["parameter", ["type"]],
  ["sphere", ["radius"]],
  ["box", ["halfSize"]],
  ["translate", ["field", "offset"]],
  ["union", ["left", "right"]],
  ["intersection", ["left", "right"]],
  ["subtract", ["left", "right"]],
  ["volume", ["source"]],
  ["material", ["field", "kind"]],
]);

const compose = {
  union: Math.min,
  intersection: Math.max,
  subtract: (left, right) => Math.max(left, -right),
};

function require(condition, code) {
  if (!condition) throw new Error(code);
}

function isRecord(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasFields(record, fields) {
  return isRecord(record) && Object.keys(record).length === fields.length &&
    fields.every(key => Object.hasOwn(record, key));
}

function isId(value) {
  return typeof value === "string" && /^[a-z][a-z0-9_]*$/.test(value);
}

function vector(value, code) {
  require(Array.isArray(value) && value.length === 3, code);
  const copy = [...value];
  require(copy.every(component => typeof component === "number"), code);
  return copy;
}

function readValue(type, value) {
  if (type === "length") {
    require(typeof value === "number", "E_TYPE");
    require(Number.isFinite(value), "E_VALUE");
    return value;
  }
  require(type === "vec3", "E_TYPE");
  const copy = vector(value, "E_TYPE");
  require(copy.every(Number.isFinite), "E_VALUE");
  return copy;
}

function field(sample) {
  return {
    type: "field",
    sample(point) {
      const value = sample(point);
      require(Number.isFinite(value), "E_NUMERIC");
      return value === 0 ? 0 : value;
    },
  };
}

function prepareNode(node, lookup, parameters, volumes) {
  switch (node.op) {
    case "constant":
      return { type: node.type, value: readValue(node.type, node.value) };
    case "parameter":
      require(node.type === "length" || node.type === "vec3", "E_TYPE");
      require(Object.hasOwn(parameters, node.id), "E_PARAMETER");
      return { type: node.type, value: readValue(node.type, parameters[node.id]) };
    case "sphere": {
      const radius = lookup(node.radius, "length").value;
      require(radius > 0, "E_VALUE");
      return field(([x, y, z]) => Math.hypot(x, y, z) - radius);
    }
    case "box": {
      const [hx, hy, hz] = lookup(node.halfSize, "vec3").value;
      require(hx > 0 && hy > 0 && hz > 0, "E_VALUE");
      return field(([x, y, z]) => Math.max(Math.abs(x) - hx, Math.abs(y) - hy, Math.abs(z) - hz));
    }
    case "translate": {
      const source = lookup(node.field, "field");
      const offset = lookup(node.offset, "vec3").value;
      return field(point => {
        const local = point.map((coordinate, axis) => coordinate - offset[axis]);
        require(local.every(Number.isFinite), "E_NUMERIC");
        return source.sample(local);
      });
    }
    case "union":
    case "intersection":
    case "subtract": {
      const left = lookup(node.left, "field");
      const right = lookup(node.right, "field");
      const combine = compose[node.op];
      return field(point => combine(left.sample(point), right.sample(point)));
    }
    case "volume": {
      require(isId(node.source), "E_NODE");
      const source = Object.hasOwn(volumes, node.source) ? volumes[node.source] : null;
      require(typeof source === "function", "E_VOLUME");
      return field(point => {
        try {
          return source([...point]);
        } catch {
          throw new Error("E_VOLUME");
        }
      });
    }
    case "material": {
      require(isId(node.kind), "E_NODE");
      const source = lookup(node.field, "field");
      return { type: "matter", sample: source.sample, material: node.kind };
    }
    default:
      throw new Error("E_OPERATION");
  }
}

export function prepareFgm0(program, bindings = {}) {
  require(hasFields(program, ["version", "nodes", "root"]), "E_PROGRAM");
  require(Array.isArray(program.nodes) && program.nodes.length > 0 && isId(program.root), "E_PROGRAM");
  require(program.version === "fgm-0", "E_VERSION");
  require(isRecord(bindings) &&
    Object.keys(bindings).every(key => key === "parameters" || key === "volumes"), "E_BINDINGS");
  const { parameters = {}, volumes = {} } = bindings;
  require(isRecord(parameters), "E_PARAMETER");
  require(isRecord(volumes), "E_VOLUME");

  const prepared = new Map();
  const parameterIds = new Set();
  function lookup(id, type) {
    require(isId(id) && prepared.has(id), "E_REFERENCE");
    const node = prepared.get(id);
    require(node.type === type, "E_TYPE");
    return node;
  }

  for (const node of program.nodes) {
    require(isRecord(node) && Object.hasOwn(node, "id") && Object.hasOwn(node, "op") && isId(node.id), "E_NODE");
    require(!prepared.has(node.id), "E_DUPLICATE");
    require(nodeFields.has(node.op), "E_OPERATION");
    require(hasFields(node, ["id", "op", ...nodeFields.get(node.op)]), "E_NODE");
    prepared.set(node.id, prepareNode(node, lookup, parameters, volumes));
    if (node.op === "parameter") parameterIds.add(node.id);
  }

  require(prepared.has(program.root), "E_REFERENCE");
  const root = prepared.get(program.root);
  require(root.type === "field" || root.type === "matter", "E_TYPE");
  require(Object.keys(parameters).every(id => parameterIds.has(id)), "E_PARAMETER");

  return point => {
    const coordinates = vector(point, "E_VALUE");
    require(coordinates.every(Number.isFinite), "E_VALUE");
    const value = root.sample(coordinates);
    return root.type === "matter" ? { value, material: root.material } : { value };
  };
}
