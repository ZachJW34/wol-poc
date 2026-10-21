import type { ApiError, Device, DeviceInput, FieldName } from "@/shared/contracts";

/** Small typed fetch helper. The browser always uses relative `/api/...` URLs. */
export class ApiFailure extends Error {
  code: string = "INTERNAL_ERROR";
  status: number = 0;
  fields?: Partial<Record<FieldName, string>>;

  constructor(message: string, status: number = 0) {
    super(message);
    this.name = "ApiFailure";
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new ApiFailure("Network request failed. Check that the server is reachable.");
  }

  if (response.status === 204) return undefined as T;

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiFailure("The server returned an unreadable response.");
  }

  if (!response.ok) {
    const failure = new ApiFailure(
      (payload as ApiError)?.error?.message ?? "The request failed.",
      response.status,
    );
    failure.code = (payload as ApiError)?.error?.code ?? "INTERNAL_ERROR";
    failure.fields = (payload as ApiError)?.error?.fields;
    throw failure;
  }

  return payload as T;
}

const jsonHeaders = { "content-type": "application/json" };

export const api = {
  listDevices: () => request<{ devices: Device[] }>("/api/devices"),
  createDevice: (input: DeviceInput) =>
    request<{ device: Device }>("/api/devices", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify(input),
    }),
  updateDevice: (id: string, input: DeviceInput) =>
    request<{ device: Device }>(`/api/devices/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: jsonHeaders,
      body: JSON.stringify(input),
    }),
  deleteDevice: (id: string) =>
    request<void>(`/api/devices/${encodeURIComponent(id)}`, { method: "DELETE" }),
  wakeDevice: (id: string) =>
    request<{ status: string; deviceId: string }>(`/api/devices/${encodeURIComponent(id)}/wake`, {
      method: "POST",
      headers: jsonHeaders,
      body: "{}",
    }),
};
