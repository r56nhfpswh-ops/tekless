# Logo

![logo](logo-512.png)

A glossy white ringed planet on an orange sunburst that swirls, with halftone dots.

| File | What it is |
| --- | --- |
| `logo-2048.png`, `logo-1024.png`, `logo-512.png`, `logo-256.png` | Full logo, square |
| `logo-icon-2048.png` | Planet and sparkles only, transparent background |
| `render.py` | Generator script that produces all of the above |

To re-render (needs `numpy`, `opencv-python-headless` and `pillow`):

```sh
cd logo && python3 render.py 4096 2048,1024,512,256 logo
```
