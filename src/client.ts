import "dotenv/config";
import { getProfile, type IconikProfile } from "./config.js";

// Current active profile (can be set at runtime)
let activeProfile: (IconikProfile & { api_url: string }) | null = null;

/**
 * Initialize the client with a specific profile
 * Call this at the start of your script if you want to use a non-default profile
 */
export function initializeProfile(profileName?: string): void {
  activeProfile = getProfile(profileName);
}

/**
 * Get the current active profile, initializing with default if needed
 */
function getActiveProfile(): IconikProfile & { api_url: string } {
  if (!activeProfile) {
    activeProfile = getProfile();
  }
  return activeProfile;
}

export interface IconikRequestOptions extends Omit<RequestInit, "headers"> {
  headers?: Record<string, string>;
}

/**
 * Make an authenticated request to the Iconik API
 */
export async function iconikRequest<T = unknown>(
  endpoint: string,
  options: IconikRequestOptions = {}
): Promise<T> {
  const profile = getActiveProfile();
  const url = `${profile.api_url}${endpoint}`;
  const headers: Record<string, string> = {
    "App-ID": profile.app_id,
    "Auth-Token": profile.auth_token,
    "Content-Type": "application/json",
    ...options.headers,
  };

  const response = await fetch(url, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Iconik API error (${response.status}): ${errorText}`);
  }

  // Handle empty responses (e.g., from DELETE requests)
  const text = await response.text();
  if (!text) return {} as T;
  return JSON.parse(text) as T;
}

/**
 * Build URL query string from params object
 */
export function buildQueryString(
  params: Record<string, string | number | boolean | undefined>
): string {
  const filtered = Object.entries(params).filter(
    ([, value]) => value !== undefined
  );
  if (filtered.length === 0) return "";
  return "?" + new URLSearchParams(
    filtered.map(([k, v]) => [k, String(v)])
  ).toString();
}

/**
 * Get info about the current profile (for display purposes)
 */
export function getCurrentProfileInfo(): { name: string; api_url: string } {
  const profile = getActiveProfile();
  return {
    name: profile.name,
    api_url: profile.api_url,
  };
}
