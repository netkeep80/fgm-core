#pragma once

#include <array>
#include <functional>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>

namespace fgm {

using Point = std::array<double, 3>;

struct Placement {
  Point translation{};
  std::array<Point, 3> rotation{{{1, 0, 0}, {0, 1, 0}, {0, 0, 1}}};
  double scale = 1;
};

struct Sample {
  double value;
  std::optional<std::string> material;
  std::optional<std::string> contributor;
  bool operator==(const Sample&) const = default;
};

struct VolumeDescriptor {
  std::string format;
  std::string sha256;
};

using VolumeSampler = std::function<double(const Point&)>;
using VolumeResolver = std::function<VolumeSampler(const VolumeDescriptor&)>;

class Error : public std::runtime_error {
 public:
  using std::runtime_error::runtime_error;
};

class Evaluator {
 public:
  static Evaluator from_package(std::string_view utf8, const VolumeResolver& resolver = {});
  Sample sample_local(const Point& point) const;
  Sample sample_world(const Point& point, const Placement& placement) const;

 private:
  struct Model;
  explicit Evaluator(std::shared_ptr<const Model> model);
  std::shared_ptr<const Model> model_;
};

}  // namespace fgm
