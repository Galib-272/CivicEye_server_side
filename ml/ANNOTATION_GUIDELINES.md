# Annotation guidelines

How to label road photos for CivicEye's road damage model, so new data matches the classes the
model uses. Use these for evaluation sets now and for any future training data.

## Before labelling

- Use only photos you have the right to use: your own, openly licensed ones (record the licence),
  or citizen photos covered by an explicit data-use policy and consent (PRD §19.6).
  Never Google Earth / Street View or other imagery whose licence does not allow it.
- Remove personal data first: blur faces and number plates; strip EXIF location if the photo will be shared.
- Record for each photo: source, licence, place (district or division), date, phone if known.

## Photo-level label (one per photo)

Pick the **most serious visible damage** on the road surface. If none is visible, `no_damage`.

| Label | Choose when | Examples | Not this label |
|---|---|---|---|
| `pothole` | A bowl-shaped hole with depth: missing surface down to base or soil | Round or irregular holes, often with loose stones or water | Shallow surface wear without depth (`asphalt_damage`) |
| `crack` | Lines or networks of cracks, the surface still in place | Single long or across cracks; alligator (crocodile-skin) networks | Cracks around a hole (`pothole`) |
| `asphalt_damage` | The top layer is broken, worn or peeling over an area, without a clear hole | Ravelling (loose aggregate), failed patches, peeled layers, broken edges | A clear hole (`pothole`) |
| `no_damage` | The road surface in the photo has no visible damage | Clean asphalt or concrete, normal markings, shadows, dirt, leaves | Damage that is small but visible: label the damage |

**Order of seriousness:** `pothole` > `asphalt_damage` > `crack` > `no_damage`. A photo with a
pothole and cracks is `pothole`.

## Which photos to leave out

Mark as `exclude` (do not label), with the reason:

- The road surface is not visible or fills under about a quarter of the photo.
- Too dark, too blurry or too small (under 96 px on the short side) to judge.
- Not a road (a wall, a field, a screenshot, a document).
- A copy, crop or near-copy of a photo already in the set (keep one; note the group).
- Flooded so the surface cannot be seen.

## Boxes (for the detector)

- Draw one box per separate damaged area, tight around the visible damage.
- One box for a connected crack network; separate boxes for separate potholes.
- Do not box damage that is too far away to see clearly (smaller than about 1% of the photo).
- Photos labelled `no_damage` have no boxes.
- Format: YOLO text files (`class cx cy w h`, fractions of width and height), class `0` = damage.

## Quality control

- Two people label every photo independently; a third decides disagreements.
- Report agreement (Cohen's kappa) per batch; investigate below 0.7.
- Keep photos of one place or one burst together in the same split (training, validation or test).
- Keep a held-out set that nobody trains on, from places and phones not in the training data.

## When unsure

Choose the label a road maintenance reviewer would most likely act on, and add a note. Unclear
photos are better excluded than labelled by guess.
