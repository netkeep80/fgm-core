#include <fgm/evaluator.hpp>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cmath>
#include <fstream>
#include <iostream>
#include <iterator>
#include <limits>
#include <string>
#include <utility>

namespace {
using Json = nlohmann::json;
using fgm::Evaluator;
using fgm::Point;
using fgm::Sample;

void check(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

template<class Action>
void rejects(const char* code, Action action) {
  try {
    action();
  } catch (const fgm::Error& error) {
    check(error.what() == std::string(code), error.what());
    return;
  }
  throw std::runtime_error(std::string("Ожидалась ошибка ") + code);
}

Json field(Json nodes, const char* root) {
  return {{"op", "program"}, {"parameters", Json::object()},
          {"program", {{"version", "fgm-0"}, {"nodes", std::move(nodes)}, {"root", root}}}};
}

Json sphere(double radius) {
  return field(Json::array({
    {{"id", "r"}, {"op", "constant"}, {"type", "length"}, {"value", radius}},
    {{"id", "body"}, {"op", "sphere"}, {"radius", "r"}},
  }), "body");
}

Json volume_field() {
  return field(Json::array({{{"id", "body"}, {"op", "volume"}, {"source", "source"}}}), "body");
}

Json with_field(Json pkg, Json next) {
  pkg["model"]["contributions"] = Json::array({
      {{"id", "body"}, {"material", "stone"}, {"priority", 1}, {"field", std::move(next)}}});
  return pkg;
}

bool close(double left, double right) {
  return std::abs(left - right) <= 1e-12 * std::max({1.0, std::abs(left), std::abs(right)});
}

void test_panel(const std::string& bytes, const Json& pkg) {
  const auto model = Evaluator::from_package(bytes);
  const Sample hole{0.5, {}, {}};
  const Sample beam{-0.5, "metal", "beam"};
  const Sample wall{-0.5, "stone", "wall"};
  check(model.sample_local({0, 0, 0}) == hole, "Сквозной проём");
  check(model.sample_local({1, 0, 0}) == beam, "Приоритет балки");
  check(model.sample_local({1, 1, 0}) == wall, "Материал стены");
  check(model.sample_local({3, 0, 0}) == Sample{1, {}, {}}, "Внешняя точка");
  check(model.sample_local({2, 1, 0}) == Sample{0, {}, {}}, "Граница");
  auto reversed = pkg;
  auto& contributions = reversed["model"]["contributions"];
  std::swap(contributions[0], contributions[1]);
  const auto reordered = Evaluator::from_package(reversed.dump());
  for (Point point : {Point{1, 1, 0}, Point{3, 0, 0}, Point{1, 0, 0}, Point{0, 0, 0}}) {
    check(model.sample_local(point) == reordered.sample_local(point), "Порядок вкладов и запросов");
  }
  contributions[0]["priority"] = contributions[1]["priority"];
  check(Evaluator::from_package(reversed.dump()).sample_local({1, 0, 0}) == beam,
        "Разрешение равного приоритета");

  const fgm::Placement placement{{4, -7, 0.25}, {{{0, -1, 0}, {1, 0, 0}, {0, 0, 1}}}, 2};
  check(model.sample_world({4, -5, 0.25}, placement) == beam, "Поворот и масштаб C02");
  auto reflected = placement;
  reflected.rotation[2][2] = -1;
  rejects("E_SPACE_TRANSFORM", [&] { model.sample_world({}, reflected); });
  auto invalid = placement;
  invalid.scale = 0;
  rejects("E_SPACE_TRANSFORM", [&] { model.sample_world({}, invalid); });
  const auto inf = std::numeric_limits<double>::infinity();
  rejects("E_SPACE_POINT", [&] { model.sample_world({inf, 0, 0}, placement); });
  rejects("E_GEOM_VALUE", [&] { model.sample_local({inf, 0, 0}); });
}

void test_operations(const Json& pkg) {
  const auto ball = Evaluator::from_package(with_field(pkg, sphere(2)).dump());
  check(ball.sample_local({0, 0, 0}).value == -2, "Внутри сферы");
  check(ball.sample_local({2, 0, 0}).value == 0, "Граница сферы");
  check(close(ball.sample_local({1, 2, 3}).value, std::sqrt(14.0) - 2), "Снаружи сферы");
  for (const auto& [op, expected] : {std::pair{"union", -2.0}, std::pair{"intersection", 1.0},
                                    std::pair{"subtract", -1.0}}) {
    auto composed = sphere(2);
    auto& nodes = composed["program"]["nodes"];
    nodes.push_back({{"id", "offset"}, {"op", "constant"}, {"type", "vec3"}, {"value", {3, 0, 0}}});
    nodes.push_back({{"id", "right"}, {"op", "translate"}, {"field", "body"}, {"offset", "offset"}});
    nodes.push_back({{"id", "combined"}, {"op", op}, {"left", "body"}, {"right", "right"}});
    nodes.push_back({{"id", "surface"}, {"op", "material"}, {"field", "combined"}, {"kind", "metal"}});
    composed["program"]["root"] = "surface";
    const auto result = Evaluator::from_package(with_field(pkg, composed).dump()).sample_local({});
    check(result.value == expected, "Точная операция CSG");
    check(result.material == (expected < 0 ? std::optional<std::string>{"stone"} : std::nullopt),
          "Материал вклада");
  }
  const Json blend = {{"op", "smooth_union"}, {"left", sphere(1)}, {"right", sphere(1)},
                      {"width", 0.5}, {"allowed", sphere(4)}, {"protected", sphere(0.25)}};
  const auto soft = Evaluator::from_package(with_field(pkg, blend).dump());
  check(soft.sample_local({}).value == -1, "Защищённая область");
  check(soft.sample_local({1, 0, 0}).value == -0.125, "Сглаженное объединение");
  check(soft.sample_local({4, 0, 0}).value == 3, "Граница области сглаживания");
}

void test_volumes(const Json& pkg) {
  auto volume = with_field(pkg, volume_field());
  const std::string digest(64, '3');
  volume["model"]["volumes"]["source"] = {{"format", "fixture"}, {"sha256", digest}};
  const auto bytes = volume.dump();
  rejects("E_VOLUME", [&] { Evaluator::from_package(bytes); });
  int calls = 0;
  const auto model = Evaluator::from_package(bytes, [&](const fgm::VolumeDescriptor& descriptor) {
    check(descriptor.format == "fixture" && descriptor.sha256 == digest, "Дескриптор источника");
    ++calls;
    return [](const Point& p) { return p[0] - 1; };
  });
  check(calls == 1 && model.sample_local({}).value == -1, "Фиксированный источник");
  const auto broken = Evaluator::from_package(bytes, [](const auto&) {
    return [](const Point&) -> double { throw std::runtime_error("Источник недоступен"); };
  });
  rejects("E_VOLUME", [&] { broken.sample_local({}); });
  const auto nonfinite = Evaluator::from_package(bytes, [](const auto&) {
    return [](const Point&) { return std::numeric_limits<double>::infinity(); };
  });
  rejects("E_NUMERIC", [&] { nonfinite.sample_local({}); });
  auto both = volume;
  auto& program = both["model"]["contributions"][0]["field"]["program"];
  program["nodes"].push_back({{"id", "r"}, {"op", "constant"}, {"type", "length"}, {"value", 2}});
  program["nodes"].push_back({{"id", "sphere"}, {"op", "sphere"}, {"radius", "r"}});
  program["nodes"].push_back({{"id", "combined"}, {"op", "union"}, {"left", "sphere"}, {"right", "body"}});
  program["root"] = "combined";
  const auto composed = Evaluator::from_package(both.dump(), [](const auto&) {
    return [](const Point&) -> double { throw std::runtime_error("Ошибка второго операнда"); };
  });
  rejects("E_VOLUME", [&] { composed.sample_local({}); });
  volume["model"]["volumes"].clear();
  rejects("E_VOLUME", [&] { Evaluator::from_package(volume.dump()); });
}

void test_invalid(const Json& pkg) {
  for (const std::string bytes : {"{,}", "{\"a\":1,\"\\u0061\":2}", "\xEF\xBB\xBF{}", "\xC0\xAF"}) {
    rejects("E_JSON", [&] { Evaluator::from_package(bytes); });
  }
  const auto nul = pkg.dump() + std::string("\0x", 2);
  rejects("E_JSON", [&] { Evaluator::from_package(nul); });
  auto changed = pkg;
  changed["interpreter"] = "fgm-0/2";
  rejects("E_PACKAGE_VERSION", [&] { Evaluator::from_package(changed.dump()); });
  changed = pkg;
  changed["camera"] = Json::object();
  rejects("E_PACKAGE", [&] { Evaluator::from_package(changed.dump()); });
  changed = pkg;
  changed["model"]["contributions"][0]["priority"] = 9007199254740992LL;
  rejects("E_CONTRIBUTION", [&] { Evaluator::from_package(changed.dump()); });
  changed = pkg;
  auto& nodes = changed["model"]["contributions"][0]["field"]["program"]["nodes"];
  nodes.push_back({{"id", "unused"}, {"op", "unknown"}});
  rejects("E_OPERATION", [&] { Evaluator::from_package(changed.dump()); });
  nodes.back() = {{"id", "unused"}, {"op", "union"}, {"left", "missing"}, {"right", "beam"}};
  rejects("E_REFERENCE", [&] { Evaluator::from_package(changed.dump()); });
  nodes.back() = {{"id", "unused"}, {"op", "sphere"}, {"radius", "extent"}};
  rejects("E_TYPE", [&] { Evaluator::from_package(changed.dump()); });

  // Повторное использование узлов не разворачивает граф при загрузке.
  auto shared = sphere(2);
  auto& program = shared["program"];
  auto previous = std::string("body");
  for (int index = 0; index < 40; ++index) {
    const auto id = "n" + std::to_string(index);
    program["nodes"].push_back({{"id", id}, {"op", "union"}, {"left", previous}, {"right", previous}});
    previous = id;
  }
  // Корень прежний. Остальные узлы всё равно проходят проверку.
  check(Evaluator::from_package(with_field(pkg, shared).dump()).sample_local({}).value == -2,
        "Подготовка общего графа");
}

}  // namespace

int main(int argc, char** argv) {
  try {
    check(argc == 2, "Требуется путь к фикстуре C04");
    std::ifstream file(argv[1], std::ios::binary);
    check(file.is_open(), "Не удалось открыть фикстуру");
    std::string bytes(std::istreambuf_iterator<char>{file}, {});
    const auto pkg = Json::parse(bytes);
    test_panel(bytes, pkg);
    test_operations(pkg);
    test_volumes(pkg);
    test_invalid(pkg);
    std::cout << "FGM C05: проверки пакета, выборки и диагностики пройдены\n";
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
