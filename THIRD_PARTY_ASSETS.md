# Third-party assets

## LimeZu Modern Interiors

- Asset: **Modern Interiors by LimeZu — limezu.itch.io**
- Project use: small, project-specific atlases containing only approved sprites actually used by the game:
  - `public/assets/limezu/furniture.png` (128×96) — 17 furniture frames covering 18 catalog ids
    (`washing_machine` and `laundry_washer` share one frame): single_bed, gaming_desk, wardrobe,
    dresser, floor_lamp, plant, bath_plant, tv_console, lounge_tv, fridge, stove, counter,
    coffee_machine, dining_table, toilet, shower, washing_machine/laundry_washer.
  - `public/assets/limezu/floors.png` (48×112) — seven rows of three opaque 16×16 floor variants,
    one row per room (r301/r302/r303/r304/lounge/bathroom/laundry).
- Reproducible pipeline: `scripts/limezu-manifest.json` (id → source single file, crop box, atlas
  position; floor room → sheet cells) + `scripts/build-limezu-atlas.py` regenerate both atlases from
  the locally licensed pack. The pack root referenced by the manifest
  (`../input_image/limezu-modern-interiors/...`) lives outside the repository.
- License note: commercial and non-commercial project use and editing are permitted; reselling or
  redistributing the original asset pack or edited asset pack is not permitted. Credit is required.

The original paid pack and its individual source images are not included in this repository.
