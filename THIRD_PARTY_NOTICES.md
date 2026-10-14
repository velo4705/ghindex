# Third-party notices

ghindex vendors two third-party assets. Neither is covered by this project's own
[MIT license](LICENSE); each keeps the terms of its upstream author.

## `src/site/space-grotesk-700.woff2` — SIL Open Font License 1.1

Space Grotesk, by Florian Karsten. Used for the `ghindex` wordmark only.

- Upstream: <https://github.com/floriankarsten/space-grotesk>
- Full license: [`LICENSES/Space-Grotesk-OFL-1.1.txt`](LICENSES/Space-Grotesk-OFL-1.1.txt)
- Copyright 2020 The Space Grotesk Project Authors

This file is a **subset** containing only the seven glyphs the wordmark uses
(`d`, `e`, `g`, `h`, `i`, `n`, `x`).

The OFL permits modification and redistribution provided no Reserved Font Name
is used by a derivative. Upstream Space Grotesk declares no Reserved Font Name
in its `OFL.txt`, so the subset may keep the `Space Grotesk` family name. The
OFL also requires that the font not be sold by itself; it is bundled here as
part of the application.

To re-cut the subset after a wordmark change:

```sh
pyftsubset space-grotesk-700.woff2 \
  --unicodes=U+0064,U+0065,U+0067,U+0068,U+0069,U+006E,U+0078 \
  --flavor=woff2 --no-hinting --desubroutinize -o space-grotesk-700.woff2
```

## `src/site/particles.min.js` — MIT

particles.js, by Matteo Bruni. The drifting background star field.

- Upstream: <https://github.com/tsParticles/particles.js> (npm `particles.js@2.0.0`)
- Full license: [`LICENSES/particles.js-MIT.txt`](LICENSES/particles.js-MIT.txt)
- Copyright (c) 2020 Matteo Bruni

MIT requires the copyright and permission notice to be retained in all copies.
This file was originally fetched pre-minified from jsDelivr, which had stripped
that notice; it has been restored as a comment header at the top of the file.
