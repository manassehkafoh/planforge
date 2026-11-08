#!/usr/bin/env bash
# Reproduces the inventory numbers quoted in docs/01-reverse-engineering-report.md.
# Usage: tools/measure-legacy.sh /path/to/projectlibre-clone
set -euo pipefail
R="${1:?path to clone of github.com/smartqubit/projectlibre}"; cd "$R"
echo "== files / LOC per module"
for d in openproj_core openproj_ui openproj_exchange openproj_reports openproj_contrib projectlibre_core projectlibre_exchange; do
  printf '%-22s %5s files %8s loc\n' "$d" "$(find $d -name '*.java' | wc -l)" "$(find $d -name '*.java' -exec cat {} + | wc -l)"
done
echo "== vendored code inside openproj_ui"
for d in openproj_ui/src/org/pushingpixels openproj_ui/src/org/apache; do
  printf '%-40s %4s files %7s loc\n' "$d" "$(find $d -name '*.java' | wc -l)" "$(find $d -name '*.java' -exec cat {} + | wc -l)"; done
echo "== TODO/FIXME/XXX/HACK markers:  $(grep -rE 'TODO|FIXME|XXX|HACK' --include=*.java . | wc -l)"
echo "== static getInstance() singletons (core+ui): $(grep -rE 'static .*getInstance\(' --include=*.java openproj_core openproj_ui | wc -l)"
echo "== test classes: $(find . -path '*test*' -name '*.java' | wc -l)"
echo "== <field> definitions in configuration.xml: $(grep -c '<field ' openproj_core/src/com/projity/configuration/configuration.xml)"
echo "== undo *Edit classes: $(ls openproj_core/src/com/projectlibre 2>/dev/null | wc -l >/dev/null; ls openproj_core/src/com/projity/undo/*Edit*.java | wc -l)"
echo "== Ant java level"; grep -n 'source="1.5"\|target="1.5"' openproj_build/build.xml
echo "== D-01: bcwp(ev) body"; grep -n 'public double bcwp(EarnedValueValues ev)' -A2 openproj_core/src/com/projity/pm/costing/EarnedValueCalculator.java
echo "== .pod format"; file openproj_build/resources/samples/*.pod
