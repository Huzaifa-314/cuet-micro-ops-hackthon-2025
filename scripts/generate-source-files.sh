#!/bin/bash
# Generate test files of various sizes for the source bucket
# Files are stored outside the project directory

SOURCE_DIR="/tmp/delineate-source-files"
mkdir -p "$SOURCE_DIR"

echo "Generating test files for source bucket..."

# Function to generate a file of specified size
generate_file() {
    local size=$1
    local filename=$2
    local filepath="${SOURCE_DIR}/${filename}"
    
    echo "Creating ${filename} (${size})..."
    
    # Use dd to create files efficiently
    if [ "$size" -lt 1048576 ]; then
        # For files < 1MB, use KB
        dd if=/dev/urandom of="$filepath" bs=1024 count=$((size / 1024)) 2>/dev/null
    else
        # For files >= 1MB, use MB
        local size_mb=$((size / 1048576))
        dd if=/dev/urandom of="$filepath" bs=1M count=$size_mb 2>/dev/null
    fi
    
    # Add some metadata to the file
    echo "File: $filename" >> "$filepath"
    echo "Size: $size bytes" >> "$filepath"
    echo "Generated: $(date -Iseconds)" >> "$filepath"
    
    echo "✅ Created ${filename} ($(du -h "$filepath" | cut -f1))"
}

# Generate files of various sizes
# Small files (1MB - 10MB)
generate_file 1048576 "file_1mb.zip"      # 1MB
generate_file 5242880 "file_5mb.zip"      # 5MB
generate_file 10485760 "file_10mb.zip"    # 10MB

# Medium files (25MB - 100MB)
generate_file 26214400 "file_25mb.zip"    # 25MB
generate_file 52428800 "file_50mb.zip"    # 50MB
generate_file 104857600 "file_100mb.zip"   # 100MB

# Large files (250MB - 500MB)
generate_file 262144000 "file_250mb.zip"  # 250MB
generate_file 524288000 "file_500mb.zip"  # 500MB

# Create a summary file
cat > "${SOURCE_DIR}/README.txt" << EOF
Source Files for Delineate Download Service
============================================

This directory contains test files of various sizes for the source bucket.

Files:
- file_1mb.zip    (1 MB)
- file_5mb.zip    (5 MB)
- file_10mb.zip   (10 MB)
- file_25mb.zip   (25 MB)
- file_50mb.zip   (50 MB)
- file_100mb.zip  (100 MB)
- file_250mb.zip  (250 MB)
- file_500mb.zip  (500 MB)

Total size: ~1 GB

Generated: $(date -Iseconds)
EOF

echo ""
echo "✅ All test files generated successfully!"
echo "📁 Location: $SOURCE_DIR"
echo "📊 Total size: $(du -sh "$SOURCE_DIR" | cut -f1)"
echo ""
ls -lh "$SOURCE_DIR"

