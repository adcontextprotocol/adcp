# Standard Formats Changelog

All notable changes to the AdCP Standard Creative Formats will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2025-09-03

### Breaking Changes 🚨

**Major Philosophy Shift: Properties in Names, Not Flags**
- Format names now include critical properties (e.g., `video_skippable_15s` instead of `video_15s` with capability flag)
- Removed capability flags in favor of descriptive naming
- Third-party serving now handled via asset types, not duplicate formats

### Added

**New Asset Types for Dynamic Creative (DCO)**:
- `dynamic_endpoint` - Webhook-based dynamic creative delivery
- `javascript` - Client-side JavaScript rendering
- `template` - Template-based creative with data binding

**New Descriptive Format Names**:
- Video: `video_skippable_15s`, `video_non_skippable_30s` (replaces generic `video_15s`)
- Display: `display_expandable_300x250`, `display_interstitial_320x480` (properties in names)
- Dynamic: `display_dynamic_300x250` (DCO format using endpoint asset)

### Changed

**Renamed Categories**:
- `foundational` → `universal` (clearer multi-publisher meaning)
- Removed `retail` category (formats work across verticals)

**Format Naming Convention**:
- All formats now use descriptive names with key properties
- Removed `3p` variants (third-party serving via asset types)
- Consistent pattern: `{type}_{property}_{size/duration}`

### Removed

- Capability flags (replaced by descriptive names)
- Duplicate third-party formats (e.g., `display_3p_300x250`)
- `retail` category (universal_carousel works for all verticals)

### Technical Improvements

- DCO modeled correctly as asset delivery method
- Cleaner taxonomy with ~35 core formats
- Format properties visible in names for better discoverability

## [1.1.0] - 2025-09-02

### Added
- **Critical IAB Standard Formats**:
  - `display_160x600` - Wide Skyscraper (high viewability sidebar format)
  - `display_970x250` - Billboard (premium above-the-fold placement)
  - `display_336x280` - Large Rectangle
  - `mobile_interstitial_320x480` - Mobile app interstitial (MRAID 3.0 compliant)
  
- **Emerging Format Categories**:
  - `native_responsive` - OpenRTB Native 1.2 compliant flexible native format
  - `video_outstream_native` - In-feed autoplay video with viewability triggers
  - `video_story_vertical` - Full-screen 9:16 story format (Instagram/TikTok style)
  - `retail_product_carousel` - E-commerce multi-product carousel (3-10 products)
  
- **New Format Categories**:
  - **Native**: Dedicated category for native advertising formats
  - **Retail**: Retail media and e-commerce specific formats

### Enhanced
- Updated core format schema to support:
  - OpenRTB compliance indicators
  - Platform-specific optimizations
  - Privacy framework integration (TCF 2.0, GPP)
  - Measurement partner specifications (OM SDK)
  
### Technical Improvements
- Increased format coverage from ~40% to ~70% of programmatic inventory
- Added critical mobile app monetization support
- Integrated social platform format requirements
- Enhanced retail media network compatibility
- Total formats increased from 19 to 28

## [1.0.0] - 2025-09-02

### Added
- Initial release of standardized creative formats for AdCP
- 30+ standard format definitions across display, video, audio, rich media, and DOOH
- 6 foundational formats that work across multiple publishers
- Asset type schema definitions (video, image, text, url, audio, html)
- Format extension mechanism for publisher customizations
- JSON Schema validation for all format definitions
- Format registry with programmatic discovery

### Format Categories
- **Display**: Standard banner formats (300x250, 728x90, 320x50, native)
- **Video**: Hosted and VAST-based video formats (15s, 30s, vertical, CTV)
- **Audio**: Standard audio and podcast formats
- **Rich Media**: Interactive and expandable formats
- **DOOH**: Digital out-of-home display formats
- **Foundational**: Publisher-agnostic formats with wide coverage

### Technical Features
- Full JSON Schema validation
- Cross-referenced asset type definitions
- Publisher extension points documented
- Compatibility with AdCP v1.0.0 and v1.1.0
- RESTful schema access via `/schemas/v1/standard-formats/` endpoint

### Breaking Changes
- N/A (Initial release)

### Deprecated
- N/A (Initial release)

### Removed
- N/A (Initial release)

### Fixed
- N/A (Initial release)

### Security
- All format definitions include secure defaults (HTTPS-only URLs, file size limits)
- Asset validation prevents malicious content types