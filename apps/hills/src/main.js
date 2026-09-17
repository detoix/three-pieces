import { describeWebGPUSupport } from './webgpu-capability.js';

window.__ready = false;

function showFailure(title, message, error) {
  const loading = document.getElementById('loading-screen');
  const heading = document.getElementById('loading-heading');
  const text = document.getElementById('loading-text');
  loading?.classList.add('wg-loading-error');
  if (heading) heading.textContent = title;
  if (text) text.textContent = message;
  if (error) console.error(error);
}

document.addEventListener('DOMContentLoaded', async () => {
  const support = describeWebGPUSupport({
    secureContext: window.isSecureContext,
    gpu: navigator.gpu,
  });
  if (!support.supported) {
    showFailure('WebGPU is unavailable', support.message);
    return;
  }

  try {
    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: 'high-performance',
    });
    if (!adapter) {
      showFailure('No WebGPU adapter', 'The browser exposes WebGPU, but it could not open this GPU.');
      return;
    }
    // Same split as the building page: the capability gate is this entry's
    // only static dependency.
    const { startHills } = await import('./runtime.js');
    await startHills({ adapter });
  } catch (error) {
    showFailure(
      'The hills did not start',
      error instanceof Error ? error.message : String(error),
      error,
    );
  }
});
