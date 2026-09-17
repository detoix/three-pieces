// Keep the viewer's browser gate independent of the rendering packages.
export function describeWebGPUSupport({ secureContext, gpu }) {
  if (!secureContext) {
    return {
      supported: false,
      code: 'insecure-context',
      message:
        'WebGPU requires HTTPS. Open this page through an HTTPS URL (or localhost), then reload it.',
    };
  }

  if (!gpu) {
    return {
      supported: false,
      code: 'webgpu-unavailable',
      message:
        'This browser or GPU does not expose WebGPU, which this field requires.',
    };
  }

  return { supported: true, code: 'available', message: '' };
}
