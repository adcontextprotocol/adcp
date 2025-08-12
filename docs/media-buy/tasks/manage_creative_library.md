---
title: manage_creative_library
sidebar_position: 14
---

# manage_creative_library

Manage assets in the creative library, including adding, updating, removing, and organizing assets with tags.

## Request Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | string | Yes | `"add"`, `"update"`, `"remove"`, `"list"`, or `"search"` |
| `library_id` | string | Yes | The library to manage |
| `asset` | object | No* | Asset details (*Required for add/update actions) |
| `asset_id` | string | No* | Asset identifier (*Required for update/remove actions) |
| `tags` | array | No | Tags for filtering or updating |
| `search_query` | string | No | Search query for list/search actions |
| `filters` | object | No | Additional filters for list/search |

### Asset Structure

```typescript
{
  asset_id?: string;         // Auto-generated if not provided
  name: string;             // Human-readable name
  type: string;             // "image", "video", "audio", "text", "logo", etc.
  url?: string;             // URL for media assets
  content?: string;         // Inline content for text assets
  metadata?: {
    width?: number;
    height?: number;
    duration?: number;      // For video/audio in seconds
    file_size?: number;     // In bytes
    mime_type?: string;
    alt_text?: string;      // For accessibility
  };
  tags: string[];          // Organizational tags
  usage_rights?: string;   // "unlimited", "limited", "exclusive"
  expires_at?: string;     // ISO date for time-limited assets
}
```

### Filter Structure

```typescript
{
  type?: string | string[];     // Filter by asset type(s)
  tags?: string[];              // Must have all specified tags
  created_after?: string;       // ISO date
  created_before?: string;      // ISO date
  usage_rights?: string;        // Filter by usage rights
  has_expiry?: boolean;         // Filter by expiration status
}
```

## Response Format

```json
{
  "message": "string",
  "success": true,
  "result": "object"
}
```

### Result Formats by Action

#### Add/Update Result
```json
{
  "asset": {
    "asset_id": "asset_123",
    "name": "Summer Campaign Hero Image",
    "type": "image",
    "url": "https://cdn.example.com/assets/summer-hero.jpg",
    "metadata": {
      "width": 1920,
      "height": 1080,
      "file_size": 2048000,
      "mime_type": "image/jpeg"
    },
    "tags": ["summer_2024", "hero_image", "lifestyle"],
    "created_at": "2024-02-15T10:00:00Z",
    "updated_at": "2024-02-15T10:00:00Z"
  }
}
```

#### List/Search Result
```json
{
  "assets": [
    {
      "asset_id": "asset_123",
      "name": "Summer Campaign Hero Image",
      "type": "image",
      "tags": ["summer_2024", "hero_image"],
      "url": "https://cdn.example.com/assets/summer-hero.jpg"
    }
  ],
  "total_count": 42,
  "page": 1,
  "page_size": 20
}
```

#### Remove Result
```json
{
  "removed_asset_id": "asset_123",
  "removed_at": "2024-02-15T10:00:00Z"
}
```

## Examples

### Example 1: Adding Assets with Tags

```json
{
  "action": "add",
  "library_id": "purina_assets",
  "asset": {
    "name": "July 4th Sale - Hero Banner",
    "type": "image",
    "url": "https://cdn.purina.com/campaigns/july4th/hero-banner.jpg",
    "metadata": {
      "width": 1200,
      "height": 628,
      "alt_text": "Save 20% on all Purina products this July 4th"
    },
    "tags": ["july_us_sale", "hero_banner", "promotional", "q3_2024"],
    "usage_rights": "unlimited",
    "expires_at": "2024-07-31T23:59:59Z"
  }
}
```

#### Response
```json
{
  "message": "Asset 'July 4th Sale - Hero Banner' added successfully to purina_assets library",
  "success": true,
  "result": {
    "asset": {
      "asset_id": "asset_july4th_hero_001",
      "name": "July 4th Sale - Hero Banner",
      "type": "image",
      "url": "https://cdn.purina.com/campaigns/july4th/hero-banner.jpg",
      "metadata": {
        "width": 1200,
        "height": 628,
        "file_size": 856320,
        "mime_type": "image/jpeg",
        "alt_text": "Save 20% on all Purina products this July 4th"
      },
      "tags": ["july_us_sale", "hero_banner", "promotional", "q3_2024"],
      "usage_rights": "unlimited",
      "expires_at": "2024-07-31T23:59:59Z",
      "created_at": "2024-02-15T10:00:00Z"
    }
  }
}
```

### Example 2: Bulk Add with Common Tags

```json
{
  "action": "add",
  "library_id": "purina_assets",
  "asset": [
    {
      "name": "July Sale - Dog Food Product Shot",
      "type": "image",
      "url": "https://cdn.purina.com/campaigns/july4th/dog-food.jpg",
      "tags": ["july_us_sale", "product_shot", "dog_food"]
    },
    {
      "name": "July Sale - Cat Food Product Shot",
      "type": "image",
      "url": "https://cdn.purina.com/campaigns/july4th/cat-food.jpg",
      "tags": ["july_us_sale", "product_shot", "cat_food"]
    },
    {
      "name": "July Sale - Promo Video",
      "type": "video",
      "url": "https://cdn.purina.com/campaigns/july4th/promo.mp4",
      "metadata": {
        "duration": 15,
        "width": 1920,
        "height": 1080
      },
      "tags": ["july_us_sale", "promotional_video", "social_media"]
    }
  ]
}
```

### Example 3: Searching by Tags

```json
{
  "action": "search",
  "library_id": "purina_assets",
  "tags": ["july_us_sale"],
  "filters": {
    "type": "image"
  }
}
```

#### Response
```json
{
  "message": "Found 12 image assets tagged with 'july_us_sale'",
  "success": true,
  "result": {
    "assets": [
      {
        "asset_id": "asset_july4th_hero_001",
        "name": "July 4th Sale - Hero Banner",
        "type": "image",
        "tags": ["july_us_sale", "hero_banner", "promotional", "q3_2024"],
        "url": "https://cdn.purina.com/campaigns/july4th/hero-banner.jpg"
      },
      {
        "asset_id": "asset_july4th_prod_001",
        "name": "July Sale - Dog Food Product Shot",
        "type": "image",
        "tags": ["july_us_sale", "product_shot", "dog_food"],
        "url": "https://cdn.purina.com/campaigns/july4th/dog-food.jpg"
      }
    ],
    "total_count": 12,
    "page": 1,
    "page_size": 20
  }
}
```

### Example 4: Updating Asset Tags

```json
{
  "action": "update",
  "library_id": "purina_assets",
  "asset_id": "asset_july4th_hero_001",
  "asset": {
    "tags": ["july_us_sale", "hero_banner", "promotional", "q3_2024", "best_performer"]
  }
}
```

### Example 5: Removing Expired Assets

```json
{
  "action": "search",
  "library_id": "purina_assets",
  "filters": {
    "created_before": "2024-08-01T00:00:00Z",
    "has_expiry": true
  }
}
```

Then remove each expired asset:
```json
{
  "action": "remove",
  "library_id": "purina_assets",
  "asset_id": "asset_july4th_hero_001"
}
```

## Tag Management Best Practices

### Recommended Tag Categories

1. **Campaign Tags**: `"july_us_sale"`, `"black_friday_2024"`, `"spring_launch"`
2. **Asset Type Tags**: `"hero_image"`, `"product_shot"`, `"lifestyle"`, `"logo"`
3. **Channel Tags**: `"social_media"`, `"email"`, `"display"`, `"video"`
4. **Temporal Tags**: `"q1_2024"`, `"seasonal"`, `"evergreen"`
5. **Performance Tags**: `"best_performer"`, `"testing"`, `"archived"`
6. **Product Tags**: `"dog_food"`, `"cat_food"`, `"treats"`, `"toys"`
7. **Audience Tags**: `"gen_z"`, `"pet_parents"`, `"new_customers"`

### Tag Naming Conventions

- Use lowercase with underscores: `"july_us_sale"` not `"July US Sale"`
- Be specific but not too granular: `"summer_2024"` not `"june_15_2024"`
- Use consistent prefixes for categories: `"product_dog_food"`, `"product_cat_food"`
- Avoid special characters except underscores

## Implementation Guide

### Asset Storage Integration

```python
def add_asset_to_library(library_id, asset_data):
    # Validate asset data
    validate_asset(asset_data)
    
    # Generate ID if not provided
    if not asset_data.get('asset_id'):
        asset_data['asset_id'] = generate_asset_id(asset_data)
    
    # Process media if URL provided
    if asset_data.get('url'):
        metadata = extract_media_metadata(asset_data['url'])
        asset_data['metadata'] = {**metadata, **asset_data.get('metadata', {})}
    
    # Add timestamps
    asset_data['created_at'] = datetime.now().isoformat()
    asset_data['updated_at'] = asset_data['created_at']
    
    # Store in library
    library = get_library(library_id)
    library.add_asset(asset_data)
    
    # Index by tags for fast retrieval
    index_asset_tags(library_id, asset_data['asset_id'], asset_data.get('tags', []))
    
    return asset_data
```

### Tag-Based Search

```python
def search_assets_by_tags(library_id, tags, filters=None):
    library = get_library(library_id)
    
    # Get assets with ALL specified tags
    asset_ids = library.get_assets_with_tags(tags)
    
    # Apply additional filters
    if filters:
        asset_ids = apply_filters(asset_ids, filters)
    
    # Retrieve asset details
    assets = [library.get_asset(aid) for aid in asset_ids]
    
    return assets
```

### Automatic Tag Suggestions

```python
def suggest_tags(asset):
    suggestions = []
    
    # Based on asset type
    if asset['type'] == 'image':
        if asset.get('metadata', {}).get('width', 0) > 1000:
            suggestions.append('high_res')
        
    # Based on filename/URL
    if 'summer' in asset.get('name', '').lower():
        suggestions.append('seasonal')
        suggestions.append('summer_2024')
    
    # Based on upload date
    quarter = get_quarter(asset.get('created_at'))
    suggestions.append(f'q{quarter}_2024')
    
    return suggestions
```