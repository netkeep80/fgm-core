import { createHash } from "node:crypto";
import { prepareFgm0 } from "./fgm-0-witness.mjs";
import { prepareMatter, prepareSmoothUnion } from "./fgm-geometry-witness.mjs";

const id = /^[a-z][a-z0-9_]*$/;
const digest = /^[a-f0-9]{64}$/;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function require(condition, code = "E_PACKAGE") {
  if (!condition) throw new Error(code);
}

function record(value) {
  return value !== null && typeof value === "object" &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function fields(value, names, code) {
  require(record(value) && Object.keys(value).length === names.length &&
    names.every(name => Object.hasOwn(value, name)), code);
}

function catalog(value, check) {
  require(record(value));
  for (const [key, item] of Object.entries(value)) {
    require(id.test(key));
    check(item);
  }
}

function checkParameter(value) {
  require(Number.isFinite(value) || (Array.isArray(value) && value.length === 3 &&
    [...value].every(Number.isFinite)));
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string" ||
      Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + [...value].map(canonicalJson).join(",") + "]";
  require(record(value));
  const entries = Object.keys(value).sort().map(key =>
    JSON.stringify(key) + ":" + canonicalJson(value[key]));
  return "{" + entries.join(",") + "}";
}

function uniqueKeys(text) {
  const stack = [];
  const colon = /[ \t\r\n]*:/y;
  for (const token of text.matchAll(/"(?:[^"\\]|\\.)*"|[{}\[\]]/gs)) {
    const symbol = token[0];
    if (symbol === "{" || symbol === "[") stack.push(new Set());
    else if (symbol === "}" || symbol === "]") stack.pop();
    else {
      colon.lastIndex = token.index + symbol.length;
      if (!colon.test(text)) continue;
      const key = JSON.parse(symbol);
      const keys = stack.at(-1);
      require(!keys.has(key), "E_JSON");
      keys.add(key);
    }
  }
}

function compileField(field, volumes) {
  require(record(field), "E_FIELD");
  if (field.op === "program") {
    fields(field, ["op", "program", "parameters"], "E_FIELD");
    catalog(field.parameters, checkParameter);
    const sample = prepareFgm0(field.program, { parameters: field.parameters, volumes });
    return point => sample(point).value;
  }
  require(field.op === "smooth_union", "E_FIELD");
  const names = ["op", "left", "right", "width", "allowed"];
  if (Object.hasOwn(field, "protected")) names.push("protected");
  fields(field, names, "E_FIELD");
  return prepareSmoothUnion({
    left: compileField(field.left, volumes),
    right: compileField(field.right, volumes),
    width: field.width,
    allowed: compileField(field.allowed, volumes),
    protectedRegion: Object.hasOwn(field, "protected")
      ? compileField(field.protected, volumes)
      : undefined,
  });
}

function compilePackage(pkg, resolveVolume) {
  fields(pkg, ["format", "interpreter", "model", "generation"]);
  require(pkg.format === "fgm-package/1" && pkg.interpreter === "fgm-0/1", "E_PACKAGE_VERSION");
  const { model, generation } = pkg;
  fields(model, ["contributions", "seed", "volumes"]);
  fields(generation, ["algorithm", "version", "resources", "parameters"]);
  require(typeof model.seed === "string" && digest.test(model.seed));
  require(typeof generation.algorithm === "string" && id.test(generation.algorithm));
  require(typeof generation.version === "string" &&
    /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(generation.version));
  catalog(generation.resources, item => require(typeof item === "string" && digest.test(item)));
  catalog(generation.parameters, checkParameter);
  catalog(model.volumes, descriptor => {
    fields(descriptor, ["format", "sha256"]);
    require(typeof descriptor.format === "string" && id.test(descriptor.format) &&
      typeof descriptor.sha256 === "string" && digest.test(descriptor.sha256));
  });

  const volumes = Object.create(null);
  for (const [key, descriptor] of Object.entries(model.volumes)) {
    const sample = resolveVolume?.({ ...descriptor });
    require(typeof sample === "function", "E_VOLUME");
    volumes[key] = sample;
  }
  require(Array.isArray(model.contributions), "E_CONTRIBUTION");
  return prepareMatter(Array.from(model.contributions, item => {
    fields(item, ["id", "material", "priority", "field"], "E_CONTRIBUTION");
    const { id, material, priority, field } = item;
    return { id, material, priority, sample: compileField(field, volumes) };
  }));
}

function normalize(pkg) {
  compilePackage(pkg, () => () => 0);
  const contributions = [...pkg.model.contributions].sort((a, b) => a.id < b.id ? -1 : 1);
  return { ...pkg, model: { ...pkg.model, contributions } };
}

function hash(domain, value) {
  return createHash("sha256").update(canonicalJson([domain, value]), "utf8").digest("hex");
}

export function parsePackage(bytes) {
  let pkg;
  try {
    const text = decoder.decode(bytes);
    pkg = JSON.parse(text);
    uniqueKeys(text);
  } catch {
    throw new Error("E_JSON");
  }
  return normalize(pkg);
}

export function serializePackage(pkg) {
  return Buffer.from(canonicalJson(normalize(pkg)), "utf8");
}

export function identifyPackage(pkg) {
  const normalized = normalize(pkg);
  const { format, interpreter, model } = normalized;
  return {
    model: hash("fgm:model:1", { format, interpreter, model }),
    package: hash("fgm:package:1", normalized),
  };
}

export function deriveSeed(pkg, purpose) {
  require(typeof purpose === "string" && id.test(purpose), "E_SEED");
  return hash("fgm:seed:1", { generation: normalize(pkg).generation, purpose });
}

export function preparePackage(pkg, resolveVolume) {
  return compilePackage(pkg, resolveVolume);
}
