import { prepareFgm0 } from "./fgm-0-witness.mjs";

function hasFields(value, fields) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) &&
    Object.keys(value).length === fields.length &&
    fields.every(field => Object.hasOwn(value, field));
}

// Правило блокирования принадлежит синтетическому примеру.
export function preparePanel(model) {
  if (!hasFields(model, ["program", "bindings", "rules"])) throw new Error("E_MODEL");
  if (!hasFields(model.rules, ["interiorBlocks"]) ||
      typeof model.rules.interiorBlocks !== "boolean") throw new Error("E_RULES");
  const { interiorBlocks } = model.rules;
  const sample = prepareFgm0(model.program, model.bindings);
  return point => {
    const contents = sample(point);
    return { ...contents, blocks: interiorBlocks && contents.value < 0 };
  };
}

export function presentPanel(sample, profile, view, points) {
  const { version, seed, color, emission } = profile;
  if (version !== 1 || !Number.isSafeInteger(seed) || seed < 0) throw new Error("E_PROFILE");
  return {
    samples: points.map(point => sample(point)),
    style: { version, color, emission, grain: seed % 256 },
    view: structuredClone(view),
  };
}
