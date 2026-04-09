---
---

Fix CSS custom property names containing dots (replace with underscores).

CSS custom properties cannot contain dots per spec. Renamed `--space-0.5`, `--space-1.5`, `--space-2.5`, and `--space-3.5` to `--space-0_5`, `--space-1_5`, `--space-2_5`, and `--space-3_5` in `design-system.css` and all usages across public HTML/JS files.
