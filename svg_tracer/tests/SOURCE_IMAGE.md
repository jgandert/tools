# Source image regression provenance

The fixture `fixtures/source.png` is the 1254×1254 image supplied by the user for
this task. On 2026-11-03 the user explicitly stated that the source is not
copyrighted and authorized moving it into the tests and using derivatives as
permanent regression assets. This permission applies to this supplied source;
it is not a general license assertion about other supplied or referenced art.

The original PNG has noninterlaced 8-bit RGB data and no embedded color profile.
Its file SHA-256 is
`125272e0439c5f050ecc7b0933ed369685f5533617bd33986f9410614331b1f1`.
Its decoded RGBA SHA-256 is
`1b2c4363278f19ee260f1560d4f4822d5541359fb252e475798a4cee62884de6`.
Independent Pillow and Sharp decoders produced identical native bytes. The test
uses a small PNG decoder with all five standard row filters and verifies that
checksum; it requires only built-in Node modules.

The frozen derivative `fixtures/source-1024-skia.rgba.gz` contains 1024×1024 RGBA
pixels compressed with gzip. Its uncompressed SHA-256 is
`28ee8010e224f06b94c54fefb2c2fb5ccf80d9da15714e33ca00882579890fb8`.
It was generated directly from the original source using `@napi-rs/canvas` 0.1.100:
loadImage(originalPNG), createCanvas(1024, 1024), imageSmoothingEnabled=true,
imageSmoothingQuality="high", drawImage(image, 0, 0, 1024, 1024), then getImageData.
Those are the application's resampling calls at its default working size.
This Skia-based reproduction exhibits the reported fan contour failure. A local
Chromium executable was unavailable, so no Chromium byte identity is claimed.
Freezing the bytes makes the core regression independent of future renderer or
resampler changes. The runtime test does not require canvas, Sharp, or a browser.

Run the slow integration test separately from the small core suite:

```sh
node tests/source-image.test.cjs
node tests/source-helix.test.cjs
node tests/auto-region-limit.test.cjs
```

The source test accepts optional arguments for a candidate core, original PNG,
and frozen RGBA gzip during staged evaluation. The normal command leaves all
three arguments unset. It verifies the original and working fixture hashes,
then traces the default 1024×1024 working size in Auto with normal noise,
boundary tolerance, minimum-area, and detail settings. It checks successful
validation, supported limits, filled-vector output, no global pixel fallback,
and preservation of 1254×1254 export dimensions.

The source probes were selected before examining a candidate. Dark fan ribs
and exterior curves must be supported by both original RGB below 80 and working
RGB below 150. One enclosed white node hole has original and working RGB above
240 and at least eight connected working pixels above 220. Its component must
remain separate from the large background in labels and fitted geometry. The test checks
assignments and final geometric ownership. The geometry check uses the core's
flattened chains with a separate ray cast. A dark raster center may fall just
outside its fitted face, so the same source component must still own a nearby
point within the quarter-pixel thin-feature allowance plus 0.0125 pixels for
flattening. Sixteen directions at two radii provide this finite local check; an
unrelated dark component cannot satisfy it. The enclosed white hole must keep
its own face at the center. Finite probes are not a universal topology proof.

The original Auto regression covers the fan-and-bulb motif near original coordinates x3–98,
y958–1087, approximately x2–80, y782–888 at the default working size. The supplied
SVG also drops several light interior ribs. Fewer segments or a smaller raster
error alone therefore cannot establish a better trace.

The region capacity limit is 20,000. Auto mixture recovery is triggered above
5,000 decoded regions before area cleanup, independently of that capacity
limit. The permanent Auto
regression still exercises the application's default working size and requires
the established recovery to remain active. This does not promise a fixed runtime
or memory budget for native-size complex artwork.

`auto-region-limit.test.cjs` is independently authored procedural artwork: 2704
black squares with intentional one-pixel gray outlines, plus exact and noisy
gray accents. Its 5,411 genuine regions exceed the former limit. The updated test
requires successful tracing with all source paint labels, gray rims, black
interiors, and both isolated accents preserved, including correlated gray-rim
noise. Erasing real outlines to meet a capacity limit is not accepted as recovery.

## Explicit two-color helix regression

The later staircase report concerns the helical ribbon near original coordinates
x0–125, y690–865. It is reproduced by the same frozen 1024×1024 working raster
with `colors: 2`, noise 10, tolerance 1.25, minimum area 6, detail protection and
smooth junctions enabled, and background removal disabled.

`source-helix.test.cjs` checks this separate failure. Source controls were selected
from the original PNG and frozen working bytes before examining the repair:
93 dark ink points and 45 candidate enclosed-paper points. The uploaded baseline
retains all 93 ink points and 40 paper points spanning 15 enclosed faces; the five
other source-white locations already join the background and are not locked in
as required failures. The regression requires all 133 retained controls to remain
owned by their corresponding fitted source regions, using an independent ray
cast. The inner and outer ribbon contours must retain fitted curves and must not
fall back as whole chains to exact pixel edges. The regression now also requires
zero exact and zero whole-chain sample fallbacks across the complete two-color
image. A separate geometric check rejects long runs of small orthogonal
staircase segments on the reported helix.

The current two-color repair preserves the frozen working palette, labels, and
component identities. Its geometry investigation replayed the same prepared
graph, and the final end-to-end export matches the investigated SVG exactly.
The Auto ordering change does not apply to explicit two-color tracing. This
identity is repair evidence rather than a requirement for all future changes:
justified paint or cleanup improvements may recover details already missing in
the baseline. The final frozen two-color trace has no exact or whole-chain sample
fallbacks. These controls are finite checks, not a general topology proof.

## Source detail cleanup regression and remaining limitations

The source-selected locations documented before the cleanup-ordering repair
include three lost dark points: working (11,807), (21,807), and (41,853),
corresponding to original (13,988), (26,988), and (50,1045). Their working RGB
values are approximately 48, 137, and 38. A fresh stage-by-stage probe corrected
the earlier attribution: all three are assigned dark #4b4b4b by quantization,
in components of two, one, and two pixels. Minimum-area cleanup then changes
these labels to white, near-white #ececec, and near-white. Recovery after cleanup
could not restore the erased fragments. The earlier claim that the latter two
were already assigned near-white before area cleanup was incorrect.

The existing conservative Auto mixture recovery now runs before area cleanup.
It consolidates supported antialias fragments before their small areas can
cause destructive merging. This restores working (11,807) and (41,853) as dark
ink and retains their finished fitted faces. Working (21,807) remains unresolved:
its one-pixel gray component has no #0b0b0b endpoint in the existing three-pixel
support neighborhood, so the conservative recovery leaves it for area cleanup.
The regression does not require that remaining loss to persist. Explicit two-paint
assignment retains all three source locations; its assignment path is unchanged.

The white node centers working (99,78) and (15,87), corresponding to original
(121,96) and (18,107), initially have enclosed white components of 16 and 14
pixels. Area cleanup previously erased fragments of their outlines and joined
both holes to the large background. Recovering mixture fragments first retains
both enclosed holes in labels and fitted geometry. The earlier retained hole at
working (25,19), original (31,23), also remains enclosed.

The permanent regression now contains 20 dark controls and three enclosed-hole
controls. These combine the original baseline-retained 18 dark points and one
hole with two dark points and two holes documented as lost before evaluating
the ordering change. Original RGB and frozen working pixels independently
support all added controls. The test requires final geometric ownership as well
as labels; added controls use the same finite ownership checks and thin-feature
allowance as the original set. They are not a general topology proof.
