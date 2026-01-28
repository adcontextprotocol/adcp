---
"adcontextprotocol": minor
---

Add video and audio technical constraint fields for CTV and streaming platforms

- Add frame rate constraints: acceptable_frame_rates, frame_rate_type, scan_type
- Add color/HDR fields: color_space, hdr_format, chroma_subsampling, video_bit_depth
- Add GOP/streaming fields: gop_interval_seconds_min/max, gop_type, moov_atom_position
- Add audio constraints: audio_required, audio_codec, audio_sampling_rate_hz, audio_channels, audio_bit_depth, audio_bitrate_kbps_min/max
- Add audio loudness fields: audio_loudness_lufs, audio_loudness_tolerance_db, audio_true_peak_dbfs
- Extend video-asset.json and audio-asset.json with matching properties
- Add CTV format examples to video documentation
