/**
 * Perspective Asset Database
 *
 * Binary file storage for perspective articles — cover images, report PDFs,
 * and general attachments. Follows the same BYTEA pattern as illustration-db.ts
 * and the committee document file storage.
 */

import { query, getPool } from './client.js';
import { createLogger } from '../logger.js';

const logger = createLogger('perspective-asset-db');

export interface PerspectiveAsset {
  id: string;
  perspective_id: string;
  asset_type: 'cover_image' | 'report' | 'attachment';
  file_name: string;
  file_mime_type: string;
  file_size_bytes: number;
  uploaded_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

const METADATA_COLUMNS = `id, perspective_id, asset_type, file_name, file_mime_type, file_size_bytes, uploaded_by_user_id, created_at, updated_at`;

/** Insert a new asset, returning metadata (no binary). */
export async function createAsset(data: {
  perspective_id: string;
  asset_type: 'cover_image' | 'report' | 'attachment';
  file_name: string;
  file_mime_type: string;
  file_data: Buffer;
  uploaded_by_user_id?: string;
}): Promise<PerspectiveAsset> {
  const pool = getPool();

  // For cover_image, replace existing one (upsert)
  if (data.asset_type === 'cover_image') {
    const result = await pool.query<PerspectiveAsset>(
      `INSERT INTO perspective_assets (perspective_id, asset_type, file_name, file_mime_type, file_data, file_size_bytes, uploaded_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (perspective_id) WHERE asset_type = 'cover_image'
       DO UPDATE SET file_name = EXCLUDED.file_name,
                     file_mime_type = EXCLUDED.file_mime_type,
                     file_data = EXCLUDED.file_data,
                     file_size_bytes = EXCLUDED.file_size_bytes,
                     uploaded_by_user_id = EXCLUDED.uploaded_by_user_id,
                     updated_at = NOW()
       RETURNING ${METADATA_COLUMNS}`,
      [data.perspective_id, data.asset_type, data.file_name, data.file_mime_type, data.file_data, data.file_data.length, data.uploaded_by_user_id || null]
    );
    return result.rows[0];
  }

  // For filename conflicts, replace
  const result = await pool.query<PerspectiveAsset>(
    `INSERT INTO perspective_assets (perspective_id, asset_type, file_name, file_mime_type, file_data, file_size_bytes, uploaded_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (perspective_id, file_name)
     DO UPDATE SET asset_type = EXCLUDED.asset_type,
                   file_mime_type = EXCLUDED.file_mime_type,
                   file_data = EXCLUDED.file_data,
                   file_size_bytes = EXCLUDED.file_size_bytes,
                   uploaded_by_user_id = EXCLUDED.uploaded_by_user_id,
                   updated_at = NOW()
     RETURNING ${METADATA_COLUMNS}`,
    [data.perspective_id, data.asset_type, data.file_name, data.file_mime_type, data.file_data, data.file_data.length, data.uploaded_by_user_id || null]
  );
  return result.rows[0];
}

/** Get asset binary data for serving. */
export async function getAssetData(
  perspectiveId: string,
  fileName: string
): Promise<{ file_data: Buffer; file_mime_type: string; file_name: string } | null> {
  const result = await query<{ file_data: Buffer; file_mime_type: string; file_name: string }>(
    `SELECT file_data, file_mime_type, file_name
     FROM perspective_assets
     WHERE perspective_id = $1 AND file_name = $2`,
    [perspectiveId, fileName]
  );
  return result.rows[0] || null;
}

/** List all assets for a perspective (metadata only, no binary). */
export async function getAssetsByPerspective(perspectiveId: string): Promise<PerspectiveAsset[]> {
  const result = await query<PerspectiveAsset>(
    `SELECT ${METADATA_COLUMNS} FROM perspective_assets WHERE perspective_id = $1 ORDER BY created_at`,
    [perspectiveId]
  );
  return result.rows;
}

/** Delete an asset by ID. */
export async function deleteAsset(id: string): Promise<boolean> {
  const result = await query(
    `DELETE FROM perspective_assets WHERE id = $1`,
    [id]
  );
  return (result.rowCount ?? 0) > 0;
}

/** Get asset metadata by type (e.g., find the cover image for a perspective). */
export async function getAssetByType(
  perspectiveId: string,
  assetType: string
): Promise<PerspectiveAsset | null> {
  const result = await query<PerspectiveAsset>(
    `SELECT ${METADATA_COLUMNS} FROM perspective_assets WHERE perspective_id = $1 AND asset_type = $2 LIMIT 1`,
    [perspectiveId, assetType]
  );
  return result.rows[0] || null;
}
