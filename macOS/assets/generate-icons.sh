#!/bin/bash
# Generate placeholder menu bar icons for Cloude Code

set -e

# Check if ImageMagick is installed
if ! command -v convert &> /dev/null; then
    echo "⚠️  ImageMagick not found. Please install it:"
    echo "   brew install imagemagick"
    echo ""
    echo "Or create icons manually (see README.md)"
    exit 1
fi

echo "🎨 Generating placeholder menu bar icons..."

# Create 22x22 standard icon (simple cloud + terminal symbol)
convert -size 22x22 xc:transparent \
    -fill black \
    -draw "ellipse 11,8 8,5 0,360" \
    -draw "ellipse 6,10 4,3 0,360" \
    -draw "ellipse 16,10 4,3 0,360" \
    -draw "rectangle 6,14 16,18" \
    -draw "line 8,16 9,16" \
    -draw "line 11,16 14,16" \
    iconTemplate.png

echo "✅ Created iconTemplate.png (22x22)"

# Create 44x44 retina icon
convert -size 44x44 xc:transparent \
    -fill black \
    -draw "ellipse 22,16 16,10 0,360" \
    -draw "ellipse 12,20 8,6 0,360" \
    -draw "ellipse 32,20 8,6 0,360" \
    -draw "rectangle 12,28 32,36" \
    -draw "line 16,32 18,32" \
    -draw "line 22,32 28,32" \
    iconTemplate@2x.png

echo "✅ Created iconTemplate@2x.png (44x44)"

# Note about .icns
echo ""
echo "📝 Note: You'll need to create icon.icns for the app bundle."
echo "   Use the instructions in README.md or a tool like Icon Slate."
echo ""
echo "✨ Placeholder icons generated successfully!"
