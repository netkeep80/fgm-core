#include <fgm/evaluator.hpp>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cmath>
#include <limits>
#include <map>
#include <set>
#include <utility>
#include <vector>

namespace fgm {
namespace {

using Json = nlohmann::json;
using Field = std::shared_ptr<const VolumeSampler>;
using Volumes = std::map<std::string, VolumeSampler>;

static_assert(std::numeric_limits<double>::is_iec559 && std::numeric_limits<double>::digits == 53);

void require(bool condition, const char* code) {
  if (!condition) throw Error(code);
}

bool finite(const Point& point) {
  return std::ranges::all_of(point, [](double v) { return std::isfinite(v); });
}

double checked(double value, const char* code = "E_NUMERIC") {
  require(std::isfinite(value), code);
  return value == 0 ? 0 : value;
}

void fields(const Json& value, std::initializer_list<const char*> keys, const char* code) {
  require(value.is_object() && value.size() == keys.size() &&
      std::ranges::all_of(keys, [&](const char* key) { return value.contains(key); }), code);
}

std::string str(const Json& value, const char* code) {
  require(value.is_string(), code);
  return value.get<std::string>();
}

bool identifier(std::string_view name) {
  const auto lower = [](char c) { return c >= 'a' && c <= 'z'; };
  return !name.empty() && lower(name.front()) && std::ranges::all_of(name, [&](char c) {
    return lower(c) || (c >= '0' && c <= '9') || c == '_';
  });
}

bool digest(std::string_view value) {
  return value.size() == 64 && std::ranges::all_of(value, [](char c) {
    return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
  });
}

bool version_triplet(std::string_view version) {
  for (int part = 0; part < 3; ++part) {
    const auto separator = version.find('.');
    if ((separator == std::string_view::npos) != (part == 2)) return false;
    const auto digits = version.substr(0, separator);
    if (digits.empty() || (digits.size() > 1 && digits.front() == '0') ||
        !std::ranges::all_of(digits, [](char c) { return c >= '0' && c <= '9'; })) return false;
    if (part < 2) version.remove_prefix(separator + 1);
  }
  return true;
}

double number(const Json& value, const char* code) {
  require(value.is_number(), code);
  return checked(value.get<double>(), code);
}

Point vector(const Json& value, const char* code) {
  require(value.is_array() && value.size() == 3, code);
  return {number(value[0], code), number(value[1], code), number(value[2], code)};
}

template<class Check>
void catalog(const Json& value, Check check) {
  require(value.is_object(), "E_PACKAGE");
  for (const auto& [id, item] : value.items()) {
    require(identifier(id), "E_PACKAGE");
    check(item);
  }
}

void parameters(const Json& value) {
  catalog(value, [](const Json& item) {
    if (item.is_array()) vector(item, "E_PACKAGE");
    else number(item, "E_PACKAGE");
  });
}

Json parse(std::string_view bytes) {
  require(!bytes.starts_with("\xEF\xBB\xBF") && bytes.find('\0') == std::string_view::npos, "E_JSON");
  std::vector<std::set<std::string>> keys;
  try {
    return Json::parse(bytes.begin(), bytes.end(), [&](int, Json::parse_event_t event, const Json& value) {
      if (event == Json::parse_event_t::object_start) keys.emplace_back();
      if (event == Json::parse_event_t::key) {
        require(keys.back().insert(value.get<std::string>()).second, "E_JSON");
      }
      if (event == Json::parse_event_t::object_end) keys.pop_back();
      return true;
    });
  } catch (const Json::exception&) {
    throw Error("E_JSON");
  }
}

enum class Type { length, vector, field, matter };

struct Node {
  Type type;
  double length{};
  Point vector{};
  Field sample{};
};

template<class SampleField>
Node make_field(SampleField sample, Type type = Type::field) {
  return {type, 0, {}, std::make_shared<const VolumeSampler>(
      [sample = std::move(sample)](const Point& p) { return checked(sample(p)); })};
}

enum class Operation { constant, parameter, sphere, box, translate, unite, intersect, subtract, volume, material };

const std::map<std::string, Operation, std::less<>> operations{
    {"constant", Operation::constant}, {"parameter", Operation::parameter},
    {"sphere", Operation::sphere}, {"box", Operation::box}, {"translate", Operation::translate},
    {"union", Operation::unite}, {"intersection", Operation::intersect},
    {"subtract", Operation::subtract}, {"volume", Operation::volume}, {"material", Operation::material},
};

struct Program {
  const Json& inputs;
  const Volumes& volumes;
  std::map<std::string, Node> nodes;
  std::size_t parameter_count{};

  const Node& lookup(const Json& reference) const {
    const auto id = str(reference, "E_REFERENCE");
    const auto found = nodes.find(id);
    require(identifier(id) && found != nodes.end(), "E_REFERENCE");
    return found->second;
  }

  const Node& lookup(const Json& reference, Type type) const {
    const auto& node = lookup(reference);
    require(node.type == type, "E_TYPE");
    return node;
  }

  Node prepare(const Json& node, const std::string& id, Operation op) {
    switch (op) {
      case Operation::constant:
      case Operation::parameter: {
        const bool parameter = op == Operation::parameter;
        if (parameter) fields(node, {"id", "op", "type"}, "E_NODE");
        else fields(node, {"id", "op", "type", "value"}, "E_NODE");
        const auto type = str(node["type"], "E_TYPE");
        require(type == "length" || type == "vec3", "E_TYPE");
        if (parameter) {
          require(inputs.contains(id), "E_PARAMETER");
          ++parameter_count;
        }
        const auto& value = parameter ? inputs[id] : node["value"];
        if (type == "length") return {Type::length, number(value, "E_TYPE")};
        return {Type::vector, 0, vector(value, "E_TYPE")};
      }
      case Operation::sphere: {
        fields(node, {"id", "op", "radius"}, "E_NODE");
        const auto radius = lookup(node["radius"], Type::length).length;
        require(radius > 0, "E_VALUE");
        return make_field([radius](const Point& p) { return std::hypot(p[0], p[1], p[2]) - radius; });
      }
      case Operation::box: {
        fields(node, {"id", "op", "halfSize"}, "E_NODE");
        const auto half = lookup(node["halfSize"], Type::vector).vector;
        require(std::ranges::all_of(half, [](double v) { return v > 0; }), "E_VALUE");
        return make_field([half](const Point& p) {
          return std::max({std::abs(p[0]) - half[0], std::abs(p[1]) - half[1], std::abs(p[2]) - half[2]});
        });
      }
      case Operation::translate: {
        fields(node, {"id", "op", "field", "offset"}, "E_NODE");
        const auto source = lookup(node["field"], Type::field).sample;
        const auto offset = lookup(node["offset"], Type::vector).vector;
        return make_field([source, offset](const Point& p) {
          const Point local{p[0] - offset[0], p[1] - offset[1], p[2] - offset[2]};
          require(finite(local), "E_NUMERIC");
          return (*source)(local);
        });
      }
      case Operation::unite:
      case Operation::intersect:
      case Operation::subtract: {
        fields(node, {"id", "op", "left", "right"}, "E_NODE");
        const auto left = lookup(node["left"], Type::field).sample;
        const auto right = lookup(node["right"], Type::field).sample;
        return make_field([left, right, op](const Point& p) {
          const auto a = (*left)(p);
          const auto b = (*right)(p);
          if (op == Operation::unite) return std::min(a, b);
          return std::max(a, op == Operation::subtract ? -b : b);
        });
      }
      case Operation::volume: {
        fields(node, {"id", "op", "source"}, "E_NODE");
        const auto name = str(node["source"], "E_NODE");
        require(identifier(name), "E_NODE");
        const auto source = volumes.find(name);
        require(source != volumes.end(), "E_VOLUME");
        return make_field([sample = source->second](const Point& p) {
          try {
            return sample(p);
          } catch (...) {
            throw Error("E_VOLUME");
          }
        });
      }
      case Operation::material: {
        fields(node, {"id", "op", "field", "kind"}, "E_NODE");
        require(identifier(str(node["kind"], "E_NODE")), "E_NODE");
        return {Type::matter, 0, {}, lookup(node["field"], Type::field).sample};
      }
    }
    throw Error("E_OPERATION");
  }
};

Field compile_program(const Json& value, const Json& inputs, const Volumes& volumes) {
  fields(value, {"version", "nodes", "root"}, "E_PROGRAM");
  const auto name = str(value["root"], "E_PROGRAM");
  require(identifier(name) && value["nodes"].is_array() && !value["nodes"].empty(), "E_PROGRAM");
  require(value["version"] == "fgm-0", "E_VERSION");
  parameters(inputs);
  Program program{inputs, volumes, {}};
  for (const auto& node : value["nodes"]) {
    require(node.is_object() && node.contains("id") && node.contains("op"), "E_NODE");
    const auto id = str(node["id"], "E_NODE");
    require(identifier(id), "E_NODE");
    require(!program.nodes.contains(id), "E_DUPLICATE");
    const auto operation = operations.find(str(node["op"], "E_OPERATION"));
    require(operation != operations.end(), "E_OPERATION");
    program.nodes.emplace(id, program.prepare(node, id, operation->second));
  }
  const auto& root = program.lookup(value["root"]);
  require(root.type == Type::field || root.type == Type::matter, "E_TYPE");
  require(program.parameter_count == inputs.size(), "E_PARAMETER");
  return root.sample;
}

Field compile_field(const Json& value, const Volumes& volumes) {
  require(value.is_object() && value.contains("op"), "E_FIELD");
  if (value["op"] == "program") {
    fields(value, {"op", "program", "parameters"}, "E_FIELD");
    return compile_program(value["program"], value["parameters"], volumes);
  }
  require(value["op"] == "smooth_union", "E_FIELD");
  const bool has_protection = value.contains("protected");
  if (has_protection) fields(value, {"op", "left", "right", "width", "allowed", "protected"}, "E_FIELD");
  else fields(value, {"op", "left", "right", "width", "allowed"}, "E_FIELD");
  auto left = compile_field(value["left"], volumes);
  auto right = compile_field(value["right"], volumes);
  auto allowed = compile_field(value["allowed"], volumes);
  auto protection = has_protection ? compile_field(value["protected"], volumes) : Field{};
  const double width = number(value["width"], "E_SMOOTH");
  require(width > 0, "E_SMOOTH");

  return std::make_shared<const VolumeSampler>([left, right, allowed, protection, width](const Point& p) {
    const double a = (*left)(p);
    const double b = (*right)(p);
    const double hard = std::min(a, b);
    const double inside = -(*allowed)(p);
    const double outside = protection ? (*protection)(p) : width;
    const double strength = std::min({width, inside, outside});
    const double difference = std::abs(a - b);
    if (strength <= 0 || difference >= strength) return hard;
    const double blend = 1 - difference / strength;
    return checked(hard - (strength / 4) * blend * blend, "E_GEOM_VALUE");
  });
}

struct Contribution {
  std::string id;
  std::string material;
  double priority;
  Field field;
};

Volumes prepare_volumes(const Json& value, const VolumeResolver& resolver) {
  Volumes volumes;
  catalog(value, [&](const Json& descriptor) {
    fields(descriptor, {"format", "sha256"}, "E_PACKAGE");
    require(identifier(str(descriptor["format"], "E_PACKAGE")) &&
        digest(str(descriptor["sha256"], "E_PACKAGE")), "E_PACKAGE");
  });
  for (const auto& [id, descriptor] : value.items()) {
    require(static_cast<bool>(resolver), "E_VOLUME");
    try {
      auto sample = resolver({descriptor["format"].get<std::string>(), descriptor["sha256"].get<std::string>()});
      require(static_cast<bool>(sample), "E_VOLUME");
      volumes.emplace(id, std::move(sample));
    } catch (...) {
      throw Error("E_VOLUME");
    }
  }
  return volumes;
}

std::vector<Contribution> compile_package(const Json& pkg, const VolumeResolver& resolver) {
  fields(pkg, {"format", "interpreter", "model", "generation"}, "E_PACKAGE");
  require(pkg["format"] == "fgm-package/1" && pkg["interpreter"] == "fgm-0/1", "E_PACKAGE_VERSION");
  const auto& model = pkg["model"];
  const auto& generation = pkg["generation"];
  fields(model, {"contributions", "seed", "volumes"}, "E_PACKAGE");
  fields(generation, {"algorithm", "version", "resources", "parameters"}, "E_PACKAGE");
  require(digest(str(model["seed"], "E_PACKAGE")) &&
      identifier(str(generation["algorithm"], "E_PACKAGE")) &&
      version_triplet(str(generation["version"], "E_PACKAGE")), "E_PACKAGE");
  catalog(generation["resources"], [](const Json& item) {
    require(digest(str(item, "E_PACKAGE")), "E_PACKAGE");
  });
  parameters(generation["parameters"]);

  const auto volumes = prepare_volumes(model["volumes"], resolver);
  const auto& source = model["contributions"];
  require(source.is_array() && !source.empty(), "E_CONTRIBUTION");
  std::set<std::string> ids;
  std::vector<Contribution> result;
  result.reserve(source.size());
  for (const auto& item : source) {
    fields(item, {"id", "material", "priority", "field"}, "E_CONTRIBUTION");
    const auto id = str(item["id"], "E_CONTRIBUTION");
    const auto material = str(item["material"], "E_CONTRIBUTION");
    const auto priority = number(item["priority"], "E_CONTRIBUTION");
    require(identifier(id) && ids.insert(id).second && identifier(material) &&
        std::abs(priority) <= 9007199254740991.0 && std::trunc(priority) == priority, "E_CONTRIBUTION");
    result.push_back({id, material, priority, compile_field(item["field"], volumes)});
  }
  std::ranges::sort(result, [](const Contribution& a, const Contribution& b) {
    return a.priority != b.priority ? a.priority > b.priority : a.id < b.id;
  });
  return result;
}

double dot(const Point& a, const Point& b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

Point cross(const Point& a, const Point& b) {
  return {a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]};
}

Point to_local(const Point& world, const Placement& pose) {
  const auto& rows = pose.rotation;
  require(finite(pose.translation) && std::ranges::all_of(rows, finite) &&
      std::isfinite(pose.scale) && pose.scale > 0, "E_SPACE_TRANSFORM");
  constexpr double tolerance = 1e-12;
  for (std::size_t i = 0; i < rows.size(); ++i) {
    for (std::size_t j = 0; j < rows.size(); ++j) {
      require(std::abs(dot(rows[i], rows[j]) - (i == j ? 1 : 0)) <= tolerance, "E_SPACE_TRANSFORM");
    }
  }
  require(std::abs(dot(rows[0], cross(rows[1], rows[2])) - 1) <= tolerance, "E_SPACE_TRANSFORM");
  require(finite(world), "E_SPACE_POINT");
  Point shifted{};
  for (std::size_t axis = 0; axis < 3; ++axis) {
    shifted[axis] = checked((world[axis] - pose.translation[axis]) / pose.scale, "E_SPACE_NUMERIC");
  }
  Point local{};
  for (std::size_t axis = 0; axis < 3; ++axis) {
    const Point column{rows[0][axis], rows[1][axis], rows[2][axis]};
    local[axis] = checked(dot(column, shifted), "E_SPACE_NUMERIC");
  }
  return local;
}

}  // namespace

struct Evaluator::Model {
  std::vector<Contribution> contributions;
};

Evaluator::Evaluator(std::shared_ptr<const Model> model) : model_(std::move(model)) {}

Evaluator Evaluator::from_package(std::string_view utf8, const VolumeResolver& resolver) {
  return Evaluator(std::make_shared<const Model>(Model{compile_package(parse(utf8), resolver)}));
}

Sample Evaluator::sample_local(const Point& point) const {
  require(finite(point), "E_GEOM_VALUE");
  Sample result{std::numeric_limits<double>::infinity(), {}, {}};
  for (const auto& contribution : model_->contributions) {
    const double value = (*contribution.field)(point);
    result.value = std::min(value, result.value);
    if (value < 0 && !result.contributor) {
      result.contributor = contribution.id;
      result.material = contribution.material;
    }
  }
  return result;
}

Sample Evaluator::sample_world(const Point& point, const Placement& placement) const {
  return sample_local(to_local(point, placement));
}

}  // namespace fgm
