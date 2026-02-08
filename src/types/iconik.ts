// Common pagination response
export interface PaginatedResponse<T> {
  objects: T[];
  page: number;
  pages: number;
  per_page: number;
  total: number;
  first_url?: string;
  last_url?: string;
  next_url?: string;
  prev_url?: string;
  scroll_id?: string;
}

// Asset types
export type AssetType =
  | "ASSET"
  | "SEQUENCE"
  | "NLE_PROJECT"
  | "PLACEHOLDER"
  | "CUSTOM"
  | "LINK"
  | "SUBCLIP";

export type AssetStatus = "ACTIVE" | "DELETED";

export type ArchiveStatus =
  | "NOT_ARCHIVED"
  | "ARCHIVING"
  | "FAILED_TO_ARCHIVE"
  | "ARCHIVED";

export type AnalyzeStatus =
  | "N/A"
  | "REQUESTED"
  | "IN_PROGRESS"
  | "FAILED"
  | "DONE";

export type ApprovalStatus =
  | "N/A"
  | "REQUESTED"
  | "APPROVED"
  | "NOT_APPROVED"
  | "MIXED";

export type VersionStatus =
  | "ACTIVE"
  | "IN_PROGRESS"
  | "FAILED"
  | "DELETING"
  | "DELETED";

// User info embedded in responses
export interface UserInfo {
  id: string;
  email?: string;
  first_name?: string;
  last_name?: string;
}

// Asset Version
export interface AssetVersion {
  id: string;
  version_number: number;
  status: VersionStatus;
  analyze_status: AnalyzeStatus;
  archive_status: ArchiveStatus;
  face_recognition_status: AnalyzeStatus;
  transcribe_status: AnalyzeStatus;
  transcribed_languages: string[];
  is_online: boolean;
  has_unconfirmed_persons: boolean;
  person_ids: string[];
  created_by_user: string;
  created_by_user_info?: UserInfo;
  date_created: string;
}

// Asset
export interface Asset {
  id: string;
  title: string;
  type: AssetType;
  status: AssetStatus;
  archive_status: ArchiveStatus;
  analyze_status: AnalyzeStatus;
  face_recognition_status: AnalyzeStatus;
  is_online: boolean;
  is_blocked: boolean;
  category?: string;
  external_id?: string;
  external_link?: string;
  warning?: string;
  site_name?: string;
  custom_keyframe?: string;
  custom_poster?: string;
  original_asset_id?: string;
  original_version_id?: string;
  original_segment_id?: string;
  time_start_milliseconds?: number;
  time_end_milliseconds?: number;
  has_unconfirmed_persons: boolean;
  person_ids?: string[];
  limit_download_to_groups?: string[];
  favoured?: boolean;
  in_collections?: string[];
  versions?: AssetVersion[];
  created_by_user: string;
  created_by_user_info?: UserInfo;
  updated_by_user?: string;
  updated_by_user_info?: UserInfo;
  deleted_by_user?: string;
  deleted_by_user_info?: UserInfo;
  date_created: string;
  date_modified: string;
  date_deleted?: string;
  date_imported?: string;
  date_viewed?: string;
  last_archive_restore_date?: string;
}

// Asset creation input
export interface AssetCreateInput {
  title: string;
  type?: AssetType;
  status?: AssetStatus;
  archive_status?: ArchiveStatus;
  analyze_status?: AnalyzeStatus;
  category?: string;
  external_id?: string;
  external_link?: string;
  collection_id?: string;
  is_blocked?: boolean;
  is_online?: boolean;
  date_created?: string;
  date_modified?: string;
}

// Asset update input
export interface AssetUpdateInput {
  title?: string;
  type?: AssetType;
  status?: AssetStatus;
  archive_status?: ArchiveStatus;
  analyze_status?: AnalyzeStatus;
  category?: string;
  external_id?: string;
  external_link?: string;
  is_blocked?: boolean;
  is_online?: boolean;
  custom_keyframe?: string;
  custom_poster?: string;
  warning?: string;
}

// Segment types
export type SegmentType =
  | "MARKER"
  | "CHAPTER"
  | "FACE"
  | "LABEL"
  | "COMMENT"
  | "SHOT_CHANGE"
  | "TRANSCRIPTION"
  | "SPEECH"
  | "SPEECH_SEGMENT"
  | "OBJECT"
  | "CUSTOM"
  | "LOGO"
  | "SENSITIVE_CONTENT"
  | "TEXT"
  | "CELEBRITY"
  | "MODERATION"
  | "MANUAL_TRANSCRIPTION"
  | "SMPTE_TIMECODE";

export interface Segment {
  id: string;
  asset_id: string;
  version_id?: string;
  segment_type: SegmentType;
  title?: string;
  text?: string;
  time_start_milliseconds: number;
  time_end_milliseconds: number;
  position_x?: number;
  position_y?: number;
  width?: number;
  height?: number;
  confidence?: number;
  person_id?: string;
  user_id?: string;
  date_created: string;
  date_modified: string;
}

export interface SegmentCreateInput {
  segment_type: SegmentType;
  title?: string;
  text?: string;
  time_start_milliseconds: number;
  time_end_milliseconds: number;
  position_x?: number;
  position_y?: number;
  width?: number;
  height?: number;
}

// Proxy
export interface Proxy {
  id: string;
  asset_id: string;
  version_id?: string;
  name: string;
  status: string;
  resolution?: string;
  size?: number;
  codec?: string;
  frame_rate?: number;
  bit_rate?: number;
  is_default?: boolean;
  url?: string;
  date_created: string;
  date_modified: string;
}

// Keyframe
export interface Keyframe {
  id: string;
  asset_id: string;
  version_id?: string;
  name?: string;
  status: string;
  time_milliseconds?: number;
  resolution?: string;
  size?: number;
  url?: string;
  is_poster?: boolean;
  date_created: string;
  date_modified: string;
}

// Format
export interface Format {
  id: string;
  asset_id: string;
  version_id?: string;
  name: string;
  status: string;
  archive_status?: ArchiveStatus;
  metadata?: Record<string, unknown>;
  component_ids?: string[];
  storage_id?: string;
  date_created: string;
  date_modified: string;
}

// File
export interface IconikFile {
  id: string;
  asset_id: string;
  format_id?: string;
  file_set_id?: string;
  name: string;
  original_name?: string;
  size?: number;
  status: string;
  checksum?: string;
  directory_path?: string;
  storage_id: string;
  date_created: string;
  date_modified: string;
}

// File Set
export interface FileSet {
  id: string;
  asset_id: string;
  format_id: string;
  version_id?: string;
  name: string;
  status: string;
  storage_id: string;
  base_dir?: string;
  component_ids?: string[];
  date_created: string;
  date_modified: string;
}

// Download URL response
export interface DownloadUrlResponse {
  url: string;
  expiration?: string;
}

// Asset History
export type HistoryOperationType =
  | "EXPORT"
  | "TRANSCODE"
  | "ANALYZE"
  | "ADD_FORMAT"
  | "DELETE_FORMAT"
  | "RESTORE_FORMAT"
  | "DELETE_FILESET"
  | "DELETE_FILE"
  | "RESTORE_FILESET"
  | "MODIFY_FILESET"
  | "APPROVE"
  | "REJECT"
  | "DOWNLOAD"
  | "METADATA"
  | "CUSTOM"
  | "TRANSCRIPTION"
  | "VERSION_CREATE"
  | "VERSION_DELETE"
  | "VERSION_UPDATE"
  | "VERSION_PROMOTE"
  | "RESTORE"
  | "RESTORE_FROM_GLACIER"
  | "ARCHIVE"
  | "RESTORE_ARCHIVE"
  | "DELETE"
  | "TRANSFER"
  | "UNLINK_SUBCLIP"
  | "FACE_RECOGNITION";

export interface AssetHistory {
  id: string;
  asset_id: string;
  version_id?: string;
  operation_type: HistoryOperationType;
  operation_description?: string;
  user_id: string;
  job_id?: string;
  share_id?: string;
  share_user_id?: string;
  system_domain_id: string;
  date_created: string;
  date_modified: string;
}

// Relation types
export interface RelationType {
  relation_type: string;
  label?: string;
  reverse_label?: string;
  date_created?: string;
}

export interface AssetRelation {
  asset_id: string;
  related_to_asset_id: string;
  relation_type: string;
  date_created: string;
}

// Transcription
export interface TranscriptionProperties {
  id: string;
  asset_id: string;
  version_id: string;
  language: string;
  speaker_labels?: Record<string, string>;
  system_domain_id: string;
}
