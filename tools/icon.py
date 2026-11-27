from pathlib import Path
from PIL import Image, ImageDraw

image = Image.new("RGBA", (256, 256))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((18, 18, 238, 238), radius=54, fill="#173f35")
draw.rounded_rectangle((70, 63, 186, 196), radius=15, outline="#f4f6ea", width=8)
draw.line((92, 63, 92, 196), fill="#f4f6ea", width=8)
for y in (90, 113, 136):
    draw.rounded_rectangle((108, y, 164, y + 6), radius=3, fill="#b8cda7")
draw.rounded_rectangle((110, 158, 147, 164), radius=3, fill="#b8cda7")
target = Path("src-tauri/icons")
target.mkdir(parents=True, exist_ok=True)
image.save(target / "icon.png")
image.save(target / "icon.ico", sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
