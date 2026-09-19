/**
 * The maintained lawn's scalar dimensions and colours, in one place.
 *
 * The target is a mown residential lawn, which is a much smaller thing than the
 * meadow most procedural examples target: blades a few centimetres tall,
 * narrow, and close together.
 */
export const LAWN = Object.freeze({
  /** Blades per square metre of ground. Lawn territory starts around 150.
   *
   *  This and `radius` multiply, and between them they are what the frame
   *  costs: at these defaults there are about half a million blades, which on
   *  a mid-range GPU is roughly as much grass as can be drawn alongside
   *  everything else in the scene.
   *
   *  It is worth knowing what that buys: 110 blades per square metre is one
   *  every 9.5 cm, and a real lawn is nearer ten thousand. At a standing eye
   *  height you are looking at ground a metre and a half away, and the gap
   *  shows. Turning `grassdensity` up fixes the near ground and costs the far
   *  ground you will never look closely at -- which is the case for a
   *  distance-graded density used by the persistent WebGPU rings. */
  density: 110,
  /** Metres. A mown lawn is 4-8 cm, and these are deliberately above it.
   *
   *  Height is the coverage lever, and it is not close. You see this ground at
   *  12 to 23 degrees from a 1.7 m eye, and a blade's projected extent there
   *  is `reach + height / tan(angle)`: the reach term is 11 mm and fixed, the
   *  height term runs 141 mm at 4 m to 424 mm at 12 m. So **93 to 97 per cent
   *  of what a blade covers comes from how tall it is**, and none of it from
   *  how wide -- width is pinned at `minBladePixels` on screen across most of
   *  that range anyway, so growing it changes nothing you can see.
   *
   *  Measured bare ground at 8 m: 43% at a 4-8 cm blade, 31% at 6-11, 22% at
   *  8-14. That hole is the worst thing in the frame and it closes here for
   *  no triangles at all -- same geometry, same draws, same storage, one
   *  scalar.
   *
   *  The honest cost is the culling sphere, which is derived from blade height
   *  in `bladeCullRadiusFactor`, so taller blades grow every sphere and more
   *  of them survive the cull. The honest risk is the look: past some height a
   *  lawn reads as unmown rather than dense. That is a judgement to make on
   *  screen, which is what `?bladeheight=` is for -- 0.73 is the 4-8 cm
   *  blade before the coverage sweep raised it. */
  minHeight: 0.055,
  maxHeight: 0.105,
  /** Metres across at the base. Real turf grass is 2-4 mm; these are above it.
   *
   *  They used to be 8-14 -- three to four times life size -- because a 3 mm
   *  blade is thinner than a pixel at walking distance and aliases into noise.
   *  That bought stability with silhouette, and it is what made the lawn read
   *  as fat spikes. `minBladePixels` buys the same stability on screen
   *  instead, so the blade no longer has to be drawn oversized to survive
   *  distance.
   *
   *  It is still drawn 1.3x life size, and that is a measurement rather than a
   *  leftover. Between about 2 m and the distance `maxThicken` caps the
   *  widening at, a blade's screen width is pinned at `minBladePixels`
   *  whatever it is modelled at, so width buys nothing there. Past the cap the
   *  pinning is over and coverage goes back to being proportional to this
   *  number -- and the cap itself moves out with it. Measured on the adapter
   *  at 1280x720 with `?underlay=solid`, going from 3.1-5.0 mm to 4.0-6.5 mm
   *  closed bare ground by 7.0 points at 6-8 m, 8.5 at 8-12 m and 7.3 at
   *  12-16 m, against 0.8 at 2-3 m where the pinning still holds.
   *
   *  So this is a coverage device aimed at one band, and it should come back
   *  down to life size when the far field stops being bought with blade
   *  geometry. `?bladewidth=0.77` is the 3.1-5.0 mm it was widened from. */
  minWidth: 0.004,
  maxWidth: 0.0065,
  /** Exponent of the blade's width falloff: `(1 - y) ** taper`.
   *
   *  Grass holds its width up the sheath and narrows over the last third. A
   *  linear falloff (taper 1) narrows from the root instead, and because it
   *  has the same outline however many segments sample it, it made every
   *  blade at every band one isosceles triangle -- a field of spikes. 0 is a
   *  rectangle. */
  taper: 0.35,
  /** Floor on a blade's *projected* width, in physical pixels.
   *
   *  A blade thinner than about a pixel does not shrink, it flickers: it
   *  catches some frames and misses others as the camera moves. Rather than
   *  drawing every blade too wide everywhere to avoid it, widen only the
   *  blades that would fall under this, only by as much as they fall short --
   *  the trick Ghost of Tsushima uses for blades turned edge-on. It covers
   *  both ways a blade goes sub-pixel: distance, and turning its edge to the
   *  camera. Costs fill, not geometry. */
  minBladePixels: 1.5,
  /** Ceiling on that widening, as a multiple of a blade's true width.
   *
   *  Load-bearing, not taste. The culling sphere is sized from the blade's
   *  true width, and a blade widened past this leaves the sphere that decides
   *  whether to draw it -- which is invisible until something at the frame
   *  edge starts winking. `test/grass-blade-bounds.test.js` holds the
   *  widest thickened blade inside the sphere across the whole size range. */
  maxThicken: 4,
  /** Blades grown from each placed crown.
   *
   *  A candidate is a crown, not a blade. Turf grass tillers -- one plant puts
   *  up several blades from one crown -- so this is what the plant does, and
   *  it is also the cheapest density there is: candidate slots, placement
   *  work, culling work and the 30 MiB of storage are all per crown and none
   *  of them move. Only the vertex stage and fill grow.
   *
   *  It multiplies every ring equally on purpose. The rings hand over to each
   *  other at matched densities, and tillering one band harder than its
   *  neighbour would put a visible step at 8 m or 24 m where today there is
   *  none. */
  /** Metres across a clump of crowns that share traits.
   *
   *  Tillering clumps at the centimetre of a single crown. This is the other
   *  scale: Ghost of Tsushima's grass picks the nearest of a scattered set of
   *  clump points and takes that clump's height and facing, so a field grows
   *  in patches -- some short, some leaning a different way -- instead of
   *  every plant being statistically identical to its neighbour. Set at a
   *  lawn's scale rather than a meadow's. */
  clumpSize: 0.45,
  /** Shortest a clump may be as a fraction of the crowns' own height.
   *
   *  Only ever shortens, for the same reason `tillerShortest` does: the
   *  culling sphere is measured from a crown's full height, and grass that
   *  grows past it is culled while still on screen. */
  clumpShortest: 0.75,
  /** How hard a clump's facing pulls its crowns round to it.
   *
   *  A weight on the clump's heading against each crown's own, so 0 leaves
   *  every crown independent and large values march them in lockstep. It is
   *  added rather than interpolated so the sum can never cancel to a zero
   *  vector, which has no direction to normalize -- which is also why
   *  `test/grass-blade-bounds.test.js` keeps it a tenth clear of 1.
   *
   *  It was 1.2, where the clump outvoted the crown: every crown in a 45 cm
   *  patch faced within a few degrees of one heading, so a patch presented one
   *  shared normal to the sun and lit or darkened as a single sheet. That
   *  grain is right for a meadow and wrong for turf -- a mown lawn is cut from
   *  every direction and is close to azimuthally isotropic. At 0.3 the crown's
   *  own yaw wins and the clump biases it, so a patch still leans without
   *  every blade in it agreeing.
   *
   *  The clump keeps its other jobs whatever this is: `clumpShortest` and the
   *  health signal are what make patches read as ground, and they are not
   *  routed through the heading. `?clumppull=1.2` is the A/B. */
  clumpPull: 0.3,
  /** Blades grown from each placed crown. See the block comment above.
   *
   *  The near ring places 1,600 crowns a square metre, so this is 6,400
   *  blades/m2 at four and 4,800 at three, against the ten thousand real turf
   *  carries. Tillering is the only lever that moves that number without
   *  touching a candidate slot.
   *
   *  Half of the cost claim above is now measured and exact. At 1280x720 on the
   *  integrated GPU this was measured on, every tiller count culled to the same 67,082 visible
   *  crowns and held the same 87.5 MiB, while submitted triangles scaled
   *  precisely with it: 208,170 at one, 624,510 at three, 832,680 at four,
   *  1,249,020 at six. Placement, culling and storage really are per crown.
   *
   *  The other half -- what a tiller costs in *time* -- is not measured, and
   *  the attempt is worth recording so it is not repeated carelessly. On that
   *  machine the same configuration spread 42 to 56 fps across runs, and in
   *  some runs a heavier setting beat a lighter one. An integrated GPU
   *  throttling under sustained load, on a machine in use, cannot resolve a
   *  difference this size. Direction is certain; magnitude is not.
   *
   *  So this number is a judgement, not a result, and it is a dial for exactly
   *  that reason: `?tillers=`, 1 to 12. Measure it on the hardware
   *  you care about before moving it
   *  and against vsync rather than an unlocked frame rate. */
  tillers: 4,
  /** Metres across the crown a tiller may stand from its neighbours.
   *
   *  A 22 mm disk spreads four tillers through most of a 25 mm near cell;
   *  the former 12 mm disk crowded them into a single visible spike. Radial
   *  samples are uniform in area, with one angular stratum per tiller.
   *
   *  Folded into the culling sphere, which is centred on the crown and must
   *  still contain the blade furthest from it. */
  tillerSpread: 0.022,
  /** Radians of yaw a tiller is fanned across, centred on the crown's facing:
   *  a blade is drawn from +/- half of this, so 1 is +/- 29 degrees.
   *
   *  Zero makes each crown a stack of parallel blades, which reads as one fat
   *  blade rather than several thin ones. Raised from 0.7 with `clumpPull`,
   *  and for the same reason: with the clump no longer supplying the variety,
   *  the four blades of a crown have to. It is yaw only -- it moves no blade
   *  further from the crown centre than `tillerSpread` already allows, so it
   *  is outside the culling sphere's arithmetic.
   *
   *  `?tillerfan=0.7` is the A/B. */
  tillerFan: 1,
  /** Shortest a tiller may be as a fraction of its crown's blade height.
   *  Real tillers are not all the same age; equal heights read as a mown
   *  bristle rather than a growing tuft. Never above 1, or a tiller outgrows
   *  the culling sphere its crown was measured for. */
  tillerShortest: 0.7,
  /** Radians the tip leans from upright at rest, drawn per blade across this
   *  range. Posture, not wind.
   *
   *  The floor was 0.1 -- 5.7 degrees, which is upright. Whatever the ceiling
   *  is, a share of every crown's blades were drawn from the bottom of this
   *  range and stood to attention, and that is what a lawn of spikes is made
   *  of. 0.2 is 11.5 degrees and no blade is vertical any more.
   *
   *  Set by eye, and worth saying why: a pixel comparison could not see it.
   *  Raising this floor by 2.5x moved the dark 5th percentile of the lawn --
   *  the gaps -- by 0.0, and the vertical-to-horizontal gradient ratio by
   *  1.2%, which is nothing. That measurement was right about what it
   *  measured: leaning a blade redistributes a 3-5 mm sliver, it does not add
   *  any, so lean cannot close a gap. Coverage is count x width x length.
   *  Character is not coverage, and this is a character change.
   *
   *  `?bendmin=0.5` restores the old floor.
   *
   *  `maxBend` is the load-bearing half. The culling pass bounds a blade with
   *  a sphere half way up it, and a leaning tip is further from that centre
   *  than an upright one. That radius is no longer a constant -- see
   *  `bladeCullRadiusFactor` in `blade-arc.js`, which derives it from this
   *  value, so raising the ceiling grows the sphere instead of quietly
   *  pushing blades outside it. `test/grass-blade-bounds.test.js`
   *  holds the two together across the whole dial range. */
  minBend: 0.2,
  maxBend: 0.55,
  /** How dark a blade's root goes, as a multiplier on its own colour.
   *
   *  A blade in turf is not lit from the soil up: it stands in a few
   *  centimetres of its neighbours, and the light reaching the bottom third of
   *  it has been through several of them. Nothing in this lawn models that --
   *  blades cast no shadow-map silhouette on purpose, at 4-8 cm it costs more
   *  than it returns -- so without this the lawn is a plane of evenly lit
   *  strips and reads flat from above, which is the angle a walking camera
   *  sees it from.
   *
   *  It multiplies albedo rather than arriving through `aoNode`, which in a
   *  standard material only attenuates indirect light: the occlusion being
   *  faked here takes the sun out too. It compounds with the existing
   *  bottom-to-top colour gradient, which is why it is 0.55 and not the 0.45
   *  a blade in isolation would want. */
  rootOcclusion: 0.55,
  /** What the ground between the blades keeps of the light an open field gets.
   *
   *  It is `rootOcclusion`, and that is a derivation rather than a coincidence.
   *  A blade's base is darkened because it stands in a few centimetres of its
   *  neighbours and sees very little sky; the ground is at *the same height as
   *  that base*, under the same neighbours, so it receives the same light. Let
   *  the two differ and every blade meets the ground at a step in brightness.
   *
   *  Nothing was doing this. The blades are `castShadow = false` on purpose --
   *  a few hundred thousand shadow-casting slivers is not a trade this package
   *  makes -- so the ground beneath them was lit as an open field in full sun
   *  while being looked at through a canopy. `assets/grass004/README.md` says
   *  AO was left out of the asset because "the dense real blade layer already
   *  supplies the relevant large-scale occlusion"; it does not, because it
   *  casts nothing. This is that occlusion, asserted.
   *
   *  The honest caveat: the ground you can *see* is the ground in the gaps,
   *  and a gap is by definition more open than the average. If the sun were at
   *  the camera that would matter and this would be too dark; it is not, so a
   *  gap open to the eye says little about a gap open to the sun.
   *
   *  `?groundao=1` turns it off. */
  groundCanopyAO: 0.55,
  /** Fraction of a blade's length the root occlusion fades out over.
   *
   *  Measured up the blade, not up the world, so a short blade is shaded like
   *  a tall one. That is the approximation: real occlusion is deepest at a
   *  fixed height above the soil, so a short blade should be darker over more
   *  of itself than a tall one. Carrying blade height into the fragment stage
   *  to model that costs a varying for a difference across a 4-8 cm spread. */
  rootOcclusionHeight: 0.38,
  /** Where a dry patch starts and where it is fully dry, on the inverted
   *  world health signal.
   *
   *  Lawn is not one green. It is greener where the ground holds water and
   *  straw-coloured where it does not, and those places are metres across, not
   *  blades across -- a lawn with 10% of its blades independently yellow is
   *  television static, which is the trap the obvious implementation falls
   *  into. `surface.healthAt()` is the patch, sampled at a 161.3 m world tile
   *  so a whole view holds a handful of them, and the *ground under the
   *  blades reads the same signal through the same function*, so a dry patch
   *  is dry all the way down instead of green turf standing on straw. */
  dryOnset: 0.35,
  dryFull: 0.9,
  /** How far a blade may differ from its patch, either way.
   *
   *  Without it a patch is a flat wash of one colour with a hard-edged
   *  neighbour. This is the only place the dry signal is allowed to be per
   *  blade, and it is a modulation of the patch rather than a probability of
   *  its own: outside a patch it multiplies zero. */
  dryScatter: 0.55,
  /** How far towards straw a fully dry blade goes. Under 1 on purpose -- a
   *  maintained lawn browns, it does not turn to hay. */
  dryStrength: 0.6,
  /** The same, for the terrain underlay. Lower, because the underlay already
   *  carries its own variation from the Grass004 albedo and is the far-field
   *  lawn: pushing it as hard as the blades makes the horizon two-tone. */
  groundDryStrength: 0.42,
  /** How much light a blade passes through itself, into the eye.
   *
   *  A blade is a fraction of a millimetre of translucent tissue: lit from
   *  behind it lights up rather than going dark, and that is most of what a
   *  lawn looks like into the sun. No roughness value produces it, because it
   *  is not a reflection -- see `blade-lighting.js`, which adds it as a real
   *  directional, shadow-gated term rather than as emissive green.
   *
   *  Kept under 1: at these values a backlit tip brightens, it does not turn
   *  into a light source. `LAWN_COLORS.backlight` is the colour it carries,
   *  which is the green the blade has taken out of the light on the way
   *  through. */
  backscatter: 0.5,
  /** Exponent on the forward-scatter lobe -- `dot(-light, view)`.
   *
   *  Only a modifier now. It used to be the whole term: transmission was
   *  `pow(dot(-L, V), 4)`, which asks whether the *camera* is pointing into
   *  the sun and never asks whether the light is behind this particular
   *  blade. For a directional sun both those vectors are shared by the whole
   *  lawn, so the answer was shared too -- turning the head lit or unlit every
   *  tip on screen together, as one sheet, which is not what grass does.
   *
   *  `backscatterAbsorb` carries the physics now and this shapes how much
   *  brighter a backlit blade gets when you also look towards the sun. Low,
   *  because a narrow lobe on top of a per-blade gate bands twice. */
  backscatterPower: 2,
  /** Beer-Lambert absorption through the thickness of a blade.
   *
   *  Light entering the far face at a slant crosses more tissue than light
   *  entering square on -- the path is the thickness over the cosine -- so the
   *  term falls as `exp(-absorb / cos)`. That is what makes a blade edge-on to
   *  the sun dark rather than merely dim, and it is the reason this reads as a
   *  material rather than as a wrap-around light.
   *
   *  At 0.25 a blade square to the sun passes 0.78 of the coefficient and one
   *  at 60 degrees passes 0.30. Multiplied by `backscatter`, the best-oriented
   *  blade sees the 0.55 the *whole lawn* used to see, and the average one
   *  sees about a third of it. */
  backscatterAbsorb: 0.25,
  /** How much of the transmission the forward lobe carries, 0 to 1.
   *
   *  Tissue scatters forward, so a backlit blade is brightest looking towards
   *  the light -- but it is still lit from behind when you are not, and a real
   *  lawn does not switch off because you turned. This splits the difference:
   *  `1 - backscatterView` of the term survives at any view angle and the lobe
   *  adds the rest. Set to 1 and the old whole-lawn coupling to camera yaw
   *  comes back, on top of the per-blade gate. */
  backscatterView: 0.4,
  /** Where along a blade transmission starts, as a fraction of its length.
   *
   *  Load-bearing against `rootOcclusion`, not taste. A blade thickens toward
   *  the sheath and stands in more of its neighbours down there, so it passes
   *  almost nothing through its base -- and the base is exactly where root
   *  occlusion is darkest. Let this reach below `rootOcclusionHeight` and the
   *  two fight: the blade glows brightest at the point the other term just
   *  darkened. `test/grass-blade-bounds.test.js` holds them apart. */
  backscatterTip: 0.45,
  /** How far the lawn's density swings between its poorest and richest ground.
   *
   *  `densityFrom` was `mix(0.78, 1, macro)` -- a 22% swing, which is real but
   *  below the threshold where a lawn stops reading as one flat green. The
   *  report this work follows is blunt about it: the macro and health signals
   *  are the right foundation and "their range is currently too restricted".
   *
   *  **It stays at 0.22, and the reason is structural.** Widening it can only
   *  widen *downwards*: retention is `density / candidateDensity` clamped to
   *  1, and every ring's target density already equals its candidate lattice
   *  at its inner edge, so there is no headroom above. Richer ground cannot
   *  get denser than the lattice; poorer ground only gets thinner. So every
   *  unit of extra swing is a unit of removed grass, and the gaps it opens are
   *  correctly dark now that the ground is occluded -- measured at a spread of
   *  0.76, the lawn read as thin and olive rather than varied, and lateral
   *  variation fell 27-35% rather than rising.
   *
   *  Adding variation here therefore needs a finer candidate lattice first,
   *  which is memory: the near ring is 412,164 slots at 2.5 cm, and halving
   *  the pitch quadruples it. `?variation=` widens it for anyone who wants to
   *  see that, and 2 is the thin olive lawn described above. */
  densitySpread: 0.22,
  /** How much of a crown's height its patch decides, against its own hash.
   *
   *  Height was drawn from one hash per crown and correlated with nothing, so
   *  a dry patch was short-of-water grass at exactly the height of the lush
   *  grass beside it, and only its colour said otherwise. Vigour is the whole
   *  point of the macro and health signals: ground that holds water grows
   *  taller as well as greener.
   *
   *  Not 1, because a patch is not a haircut -- the crown's own hash keeps the
   *  spread that stops a dense stand reading as one mown surface. At 0.45 a
   *  crown is a bit over half its own and the rest its patch's.
   *
   *  Bounded above by the same `maxHeight` as before, so the culling sphere is
   *  untouched, and it costs nothing: one `mix` on a value placement already
   *  draws, no storage, no draw, no vertex work.
   *
   *  **It is kept on physics, not on a measurement, and that should be said
   *  plainly.** Lateral luminance variation moved -6%, -5% and -8% at one, two
   *  and four metres, which is no improvement on the metric available. What
   *  the metric cannot see is the thing it fixes: a dry patch is a patch where
   *  the grass is *short as well as straw-coloured*, and before this the only
   *  thing marking one was its colour. A better test than variance would put a
   *  dry patch in frame and measure its blade heights against the lush ground
   *  beside it; that is the test to run before raising this. */
  heightCorrelation: 0.45,
  /** How much light the far-field canopy passes towards the eye, and how
   *  tightly that lobe is aimed.
   *
   *  The blades transmit -- `backscatter` and the rest of that group -- and
   *  until this existed the underlay did not, so the lawn's backlighting
   *  stopped at the distance the proxy took over. That was correct while the
   *  underlay was ground, because ground does not transmit; it stopped being
   *  correct the moment the underlay started standing in for grass.
   *
   *  Weaker than the blades' 0.7 on purpose. A blade the sun is behind
   *  transmits almost all of what gets through it; a canopy is a mixture of
   *  blades at every angle, only some of which are backlit from where you
   *  stand, so the aggregate is a fraction of the single-blade case.
   *
   *  Gated on the view and not on a normal, which is the opposite of the
   *  blades' term and is the point -- see `GRASS_BACKLIGHT.canopy`. */
  canopyBacklight: 0.25,
  canopyBacklightPower: 3,
  /** How far the far field's canopy normal leans with the lawn's grain.
   *
   *  A lawn has a grain -- growth, mowing, prevailing wind -- that runs over
   *  tens of metres, and a canopy leaning one way returns light differently
   *  from one leaning the other. That is most of why a real lawn changes as
   *  you walk round it rather than staying one flat green, and the far field
   *  here had none of it: the proxy stands in for grass but is lit as a level
   *  plane.
   *
   *  It belongs to the *underlay's* normal and not to the crowns, and that is
   *  measured rather than assumed. Pulling each crown's own yaw towards the
   *  grain was tried first and it made the lawn flatter, not richer: lateral
   *  variation fell 21% at a metre and 50% at four. The reason is that
   *  `canopyNormalNear`/`Far` exist to suppress exactly the orientation-driven
   *  brightness differences a grain creates -- a patch that happens to face the
   *  sun going bright beside one that does not -- so the two cancel. With the
   *  canopy pull switched off the same grain added 1-9%, which is the same
   *  finding from the other side. The blades aggregate; the canopy they
   *  aggregate *into* is what carries a direction.
   *
   *  It is **off by default**, because three measurements could not show it
   *  doing anything good. In the canopy normal it moved lateral variation by
   *  +3%, +1% and -3% at one, two and four metres -- nothing. Turning the
   *  camera through three headings, the far field's luminance range went from
   *  0.037 to 0.022, a *41% smaller* response, which is the opposite of the
   *  point; that test is confounded, since turning also looks at different
   *  ground, but a confounded test that comes out backwards is not evidence
   *  for shipping it either.
   *
   *  So the code, the measurement and the dial are here and the default is 0,
   *  which builds no node at all and leaves the shader exactly as it was.
   *  `?grain=` turns it on for anyone who wants to take the question further:
   *  the honest next step is a sun sweep over fixed ground rather than a
   *  camera sweep over moving ground. */
  canopyGrain: 0,
  /** Radians the shading normal splays out at a blade's edge.
   *
   *  A blade is two vertices wide, so it is flat, and shading it by its true
   *  facing makes every blade a solid wedge of one colour -- the cutout look.
   *  Real blades are curved in section and catch light across their width, so
   *  the normal is splayed toward each edge and interpolated between them.
   *  This is a lighting fiction over flat geometry, and it is the cheapest
   *  thing in the lawn that reads as roundness. */
  normalSpread: 0.8,
  /** How far a blade's *shading* normal is pulled toward the ground's: close
   *  up, and far off.
   *
   *  A blade is 3 mm wide. Past a few metres a pixel covers several of them,
   *  and shading each by its own literal facing is then the same lie across a
   *  patch that the flat two-vertex strip is across a blade -- the one
   *  `normalSpread` exists to fix. A clump that happens to present its faces
   *  to the sun goes bright and the clump beside it goes dark, and the lawn
   *  reads as slabs rather than as one canopy. Pulling the normal toward the
   *  ground's is what a thousand unresolved facings actually average to: the
   *  surface they all stand on. AMD's 2024 procedural grass keeps a quarter of
   *  the blade normal for the same reason.
   *
   *  It is the *shading* normal only. The transmission term keeps the blade's
   *  own -- see `GrassLightingModel`, which asks whether the sun is behind
   *  *this* blade, and a normal tipped up towards the sky answers no for the
   *  whole lawn at once under a high sun. That is the trap in this change: it
   *  is one line to write and it silently deletes the term the blades were
   *  just given.
   *
   *  `?canopy=0` is the A/B: every blade shaded by its own
   *  literal facing, as shipped. */
  canopyNormalNear: 0.3,
  canopyNormalFar: 0.6,
  /** Metres the pull ramps from `canopyNormalNear` to `canopyNormalFar` over.
   *
   *  Both ends sit inside a ring rather than on a ring boundary -- 4 m is
   *  inside the 8 m near ring and 28 m inside the far one -- because a ramp
   *  that ended where a ring does would change the lawn's shading exactly
   *  where its density contract promises no step. */
  canopyNormalFrom: 4,
  canopyNormalTo: 28,
  /** Half-width, in metres, of the square patch grass is grown on. See
   *  `createLawnPatch`: this is the draw-distance dial, because density is per
   *  unit area. Sized to cover the planting -- the default garden is about 50 m
   *  across -- and the camera starts a few metres outside it, so the opening
   *  frame is grass rather than the bare strip in front of it. */
  radius: 34,
  /** How much of the Grass004 photograph's own patchiness is divided out.
   *
   *  The asset is a photograph of a lawn, and it carries that lawn's metre-
   *  scale light and dark blotches. Close to the camera they are the most
   *  visible thing in the ground: soft patches no blade, clump or dry area
   *  here agrees with, because they belong to a different lawn -- and they
   *  fight the variation this one asserts, since `macroAt` and `healthAt`
   *  decide where this lawn is lighter and the photograph then says somewhere
   *  else. 1 divides them out and leaves every finer frequency, which is the
   *  blade-scale detail the asset is here for. `?flatten=0` is the A/B. */
  groundFlatten: 1,
  /** Where the underlay stops being ground seen between blades and starts
   *  being the blades themselves, in metres.
   *
   *  Two measurements meet here, and the pair is the whole justification:
   *
   *  - **8 m is where a blade stops being resolvable.** One screen pixel there
   *    covers about 0.6 of a blade; by 16 m it covers 2.7. Past that a pixel
   *    is an average of grass rather than a look at one blade, and what it
   *    should average to is grass, not the ground behind it.
   *  - **26 m is where there is nothing else left.** Bare ground measures 41%
   *    at 3-4 m, 69% at 8-12 m, 95% at 16-24 m and over 99% past 24 m at
   *    this preset's own blade size (measured on the render, off-screen,
   *    rather than derived). The hills demo draws its blades at 0.65 of that
   *    size and leaves more ground bare near the camera -- 57% at 3-4 m, 80%
   *    at 8-12 m, 97% at 16-24 m -- but the far end is the same: over 99%
   *    past 24 m. The far ring still draws blades out to 52 m and they cover
   *    nothing, so beyond here the lawn *is* the underlay and it had better
   *    look like a lawn.
   *
   *  Below the near end nothing changes: a gap at 2 m is centimetres across,
   *  you can see into it, and what belongs in it is ground. This does not fix
   *  what the ground looks like close up -- that is a separate fault and this
   *  is not aimed at it.
   *
   *  Re-measure with `apps/hills/scripts/measure-lawn-coverage.mjs` when blade
   *  height, width, tillering or ring density move; both numbers come from the
   *  curve, not from taste.
   *  `?proxy=0` is the A/B. */
  canopyProxyFrom: 8,
  canopyProxyTo: 26,
  /** Where the far-field canopy colour sits on the blade's own root-to-tip
   *  ramp. Towards the tip, because a blade stands in its neighbours and the
   *  part of it a distant pixel averages is the part that is not buried. */
  canopyProxyTip: 0.65,
  /** What the far field keeps of the light a flat plane of the same albedo
   *  would return.
   *
   *  A canopy is darker than a plane painted its colour: light that gets in
   *  between the blades mostly does not get back out, which is the same reason
   *  `rootOcclusion` darkens the bottom of every blade. The proxy has no
   *  blades to trap anything, so without this it returns everything and the
   *  distance lights up.
   *
   *  The number is set against photographs rather than by eye, and it is the
   *  only one here calibrated against something outside this repository. Real
   *  grass does brighten with distance -- haze -- but by a bounded amount:
   *  three usable CC-BY photographs measure **+20%, +37% and +50%** from their
   *  nearest ground to their farthest, mean +36. The render here measured +51%
   *  before the proxy and +70% after it, outside that range in both cases.
   *
   *  Note this is not compensating for missing haze: there is no fog in this
   *  scene at all, so a hazier render would be brighter still, not darker. The
   *  far field was simply returning light a canopy would have kept.
   *
   *  It was swept twice. The first sweep landed 0.60, for +42%. Then
   *  `canopyBacklight` gave the far field a view lobe, so part of its
   *  brightness began arriving from the direction it should -- and the flat
   *  diffuse level it needed underneath dropped accordingly. The second sweep:
   *  0.60 gives +60%, 0.50 gives +50%, **0.42 gives +41%**. That the number
   *  moved when a directional term was added is the expected shape of the
   *  thing, not a sign either sweep was wrong: a constant standing in for a
   *  model shrinks as the model arrives.
   *
   *  Re-measure it the same way if the sun, the palette or the proxy's ramp
   *  move. It is the only number here calibrated against something outside
   *  this repository. */
  canopyProxyOcclusion: 0.75,
  /** Roughness of a blade, and of the far field once it stands for blades.
   *
   *  One number because the two have to agree: the moment the underlay is
   *  standing in for grass, a difference between them is a change of material
   *  along a line on the ground at the distance the proxy fades in. */
  bladeRoughness: 0.92,
  shadows: true,
});

/**
 * How far a clump pull must stay clear of 1, either side.
 *
 * A crown's heading is its own unit vector plus its clump's times the pull, so
 * at exactly 1 an opposed pair cancels to a vector with no direction to
 * normalize. The preset, the `?clumppull=` dial and `createGPUDrivenGrass`'s
 * guard all measure that band against this one number, because two of them
 * disagreeing by a float is a NaN blade nobody can find.
 */
export const CLUMP_PULL_MARGIN = 0.1;

/**
 * Shortest canopy-pulled normal that is still a direction.
 *
 * `mix(bladeNormal, groundNormal, pull)` shortens as the two disagree, and a
 * blade folded past horizontal by `?bendmax=` can face almost exactly away
 * from the sky -- at which point a pull near a half cancels it to nothing and
 * `normalize()` has no answer. The vertex stage falls back to the blade's own
 * normal below this length rather than normalizing a zero vector.
 * `test/grass-blade-bounds.test.js` shows the shipped bend range never
 * comes near it.
 */
export const CANOPY_PULL_FLOOR = 1e-3;

/**
 * Most of a blade's own facing the canopy pull may take.
 *
 * The pull is a mix weight toward the ground's normal, so at 1 there is no
 * blade left in the shading normal at all and the ring lights as the plane it
 * stands on -- a lit lawn-coloured surface with grass-shaped geometry in front
 * of it. The `?canopy=` dial clamps here and `createGPUDrivenGrass` rejects
 * anything past it, so the two cannot disagree about where that is.
 */
export const CANOPY_PULL_MAX = 0.9;

/**
 * The greens as they were first authored, before any hue correction.
 *
 * Kept separately from `LAWN_COLORS` because the correction is computed from
 * them rather than baked into them: the target is a dial, and a palette that
 * had already been rotated once could not be rotated again without drifting.
 */
const AUTHORED_COLORS = Object.freeze({
  bottom: '#4e6b32',
  top: '#638046',
  backlight: '#89ad60',
  /** What the terrain under the blades is painted, so bald spots read as turf
   *  seen edge-on rather than as bare earth. */
  ground: '#3c5a1d',
});

/** Mean sRGB of `assets/grass004/lawn-albedo-roughness.webp`, hue 72.0.
 *
 *  Measured off the asset, and the reason the underlay needs a tint at all: it
 *  is a photograph and cannot be repainted, only multiplied. Re-measure it if
 *  the asset is ever replaced or re-optimized. */
export const GRASS004_ALBEDO_MEAN = '#606c30';

/**
 * Hue the palette is drawn around, in degrees.
 *
 * Not taste, and not eyeballed. Turfgrass research scores lawn colour with the
 * Dark Green Colour Index, whose hue transform is `(H - 60) / 60` -- scaled so
 * 60 degrees is the yellow end of a lawn and 120 the deep-green end, with
 * published thresholds for healthy turf running 60-120. A reference photograph
 * of a well-fed lawn measures **99 degrees** and holds it at every depth, near
 * the upper middle of that range.
 *
 * The lawn first rendered at **75**, scoring 0.26 on that axis against the
 * photograph's 0.65. Three things stacked the same way to get there: the blade
 * greens were authored at 87-91, the Grass004 underlay is 72, and the sun is
 * `#fff0cd` -- a warm light, which costs another 5 to 7 degrees on the way
 * through. Nothing was as yellow as the result.
 *
 * So the albedo has to overshoot the target it is aiming the *image* at, and
 * how far is measured rather than derived. Rendered mean hue over six depth
 * bands is a straight line in this number, at a slope of 0.93 degrees of
 * image per degree of palette, and **92 is the one that lands 99**:
 * 90 lands 97.3, 92 lands 99.0, 94 lands 101.0.
 *
 * **It moves whenever anything changes what a pixel of lawn is made of**, and
 * it has now done so three times, in both directions:
 *
 * - It was 105, and the canopy proxy pushed it *up* to 107 -- the opposite of
 *   what the overshoot argument predicts. 105 was never landing 99: it landed
 *   99 near the camera and 85 at the horizon, because past 20 m the lawn was
 *   almost entirely the hue-72 underlay. The proxy put the far field back on
 *   the palette, which was most of what the overshoot was reaching for.
 * - Then `groundCanopyAO` pushed it back *down* to 104.4, because darkening
 *   the ground between the blades leaves the blades -- which are already on
 *   the palette -- carrying more of every pixel.
 * - Then the lights stopped being authored. The atmosphere's own sun is
 *   `#fff3e2` where `#fff0cd` was, and its own skylight is `#88bdff` where a
 *   near-neutral `#e8f4e3` was -- skylight really is that blue -- and between
 *   them they carried the rendered image up 12.2 degrees at unchanged
 *   luminance, so the palette came down the same distance to **92**.
 *
 * That last one is worth more than its number. The overshoot over the
 * authored hue was 17.7 degrees and is now 5.3: **most of what the palette was
 * compensating for was the lighting being wrong, not the underlay.** An
 * authored warm sun and a neutral ambient were yellowing every pixel, and the
 * palette was being rotated green to cancel a cast that should never have been
 * there. `?skylights=off` restores that pair and puts 12 of those degrees back.
 *
 * The lesson is the dependency, not the number: this is a property of the
 * rendered image, so it has to be re-swept after any change to the underlay,
 * the occlusion, the lights or the blades' coverage. Every number above came
 * out of a rendered-hue sweep over flat ground at the preset's blade size;
 * `apps/hills/scripts/measure-lawn-hue.mjs` is that sweep for the hills demo,
 * where 92 lands a mean of 100.4 at the demo's own dials (one trial, see
 * `docs/measuring.md`). A degree and a half is inside what the reference
 * photographs hold; move this constant only on a repeated sweep, never to
 * chase one run. Two dials move it at a glance -- `?proxy=0` drops the
 * rendered mean about 5 degrees and
 * `?groundao=1` drops it about 1, the latter being the *opposite* of what this
 * comment used to claim and the same direction as the `groundCanopyAO` note
 * three paragraphs up. `?lawnhue=86.7` is the palette as it was authored.
 *
 * A practical trap when re-sweeping: the palette is stored as 8-bit hex, so
 * the luminance the rotation solves back to carries about 0.002 of
 * quantization noise -- which is exactly the tolerance
 * `test/grass-blade-bounds.test.js` holds it to. The drift across
 * neighbouring values is erratic rather than smooth (0.0015 at 103.6, 0.0023
 * at 104.0, 0.0017 at 104.4), so an occasional value fails that test by luck
 * and not because the hue is wrong. Step over it rather than widening the
 * tolerance, which is there to catch a real repaint.
 *
 * One thing it does not fix: the render dips two to three degrees between 4
 * and 16 m relative to either side, at every hue on the sweep. That is the
 * band where blades are still resolvable and thinning fastest, and it is a
 * separate fault.
 */
export const LAWN_TARGET_HUE = 92;

/** The hue the palette was authored around -- the blade tip, at 86.7. Every
 *  other colour is rotated by the same delta rather than snapped to the
 *  target, so the few degrees that separate root from tip survive. */
const AUTHORED_HUE = 86.7;

const toLinear = (channel) =>
  channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;

/** Relative luminance of a 0-1 RGB triple. */
function luminanceOf([red, green, blue]) {
  return (
    0.2126 * toLinear(red) + 0.7152 * toLinear(green) + 0.0722 * toLinear(blue)
  );
}

function parseHex(hex) {
  const digits = hex.replace('#', '');
  return [0, 2, 4].map((at) => parseInt(digits.slice(at, at + 2), 16) / 255);
}

function formatHex(rgb) {
  return `#${rgb
    .map((channel) =>
      Math.round(Math.max(0, Math.min(1, channel)) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

function hueSaturationOf([red, green, blue]) {
  const high = Math.max(red, green, blue);
  const low = Math.min(red, green, blue);
  const span = high - low;
  let sextant = 0;
  if (span > 0) {
    if (high === red) sextant = ((green - blue) / span) % 6;
    else if (high === green) sextant = (blue - red) / span + 2;
    else sextant = (red - green) / span + 4;
  }
  return {
    hue: (((sextant * 60) % 360) + 360) % 360,
    saturation: high === 0 ? 0 : span / high,
  };
}

function fromHueSaturationValue(hue, saturation, value) {
  const chroma = value * saturation;
  const second = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const base = value - chroma;
  const wheel = [
    [chroma, second, 0],
    [second, chroma, 0],
    [0, chroma, second],
    [0, second, chroma],
    [second, 0, chroma],
    [chroma, 0, second],
  ][Math.floor((((hue % 360) + 360) % 360) / 60)];
  return wheel.map((channel) => channel + base);
}

/**
 * The same colour at a different hue, holding its saturation *and its exact
 * linear luminance*.
 *
 * Holding luminance is what makes this a hue correction rather than a repaint.
 * Rotating a hue in HSV alone changes how bright the colour reads -- the eye
 * weights green nearly four times red -- so a naive rotation would move two
 * things at once and there would be no way to tell which one did the work.
 * Solved rather than derived: value is bisected until the luminance matches.
 */
function atHue(hex, hue) {
  const rgb = parseHex(hex);
  const target = luminanceOf(rgb);
  const { saturation } = hueSaturationOf(rgb);
  let low = 0;
  let high = 1;
  for (let step = 0; step < 64; step += 1) {
    const middle = (low + high) / 2;
    if (luminanceOf(fromHueSaturationValue(hue, saturation, middle)) < target) {
      low = middle;
    } else {
      high = middle;
    }
  }
  return fromHueSaturationValue(hue, saturation, (low + high) / 2);
}

/**
 * The lawn's greens, drawn around `hue`.
 *
 * `groundTint` is the odd one out and has to be: the underlay is a photograph,
 * so it cannot be given a colour, only multiplied by one. It carries the
 * asset's own mean from 72 degrees to the target at unchanged luminance, which
 * is a per-channel multiplier the shader applies to every texel.
 */
export function lawnColorsFor(hue = LAWN_TARGET_HUE) {
  const delta = hue - AUTHORED_HUE;
  const shifted = Object.fromEntries(
    Object.entries(AUTHORED_COLORS).map(([name, hex]) => [
      name,
      formatHex(atHue(hex, hueSaturationOf(parseHex(hex)).hue + delta)),
    ]),
  );
  const mean = parseHex(GRASS004_ALBEDO_MEAN);
  const tinted = atHue(GRASS004_ALBEDO_MEAN, hue);
  return Object.freeze({
    ...shifted,
    groundTint: Object.freeze(
      tinted.map((channel, index) => channel / mean[index]),
    ),
  });
}

/** Lawn green, shared so the candidates are compared on shading, not on hue. */
export const LAWN_COLORS = lawnColorsFor(LAWN_TARGET_HUE);

/**
 * How many blades a patch of this area wants, with a caller-selected ceiling.
 */
export function bladeCountFor(area, density, ceiling = Infinity) {
  return Math.max(1, Math.min(Math.floor(area * density), ceiling));
}
