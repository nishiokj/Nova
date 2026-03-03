import { getErrorMessage } from './error_handlers.js';
import type { HarnessLogger } from './harness_infra.js';

export interface OptionalPluginSpec {
  id: string;
  moduleName: string;
  installHint: string;
}

/**
 * Centralized optional plugin resolution with per-module caching.
 * Keeps plugin-loading policy out of harness feature code.
 */
export class HarnessPluginRegistry {
  private readonly cache = new Map<string, Promise<unknown | null>>();

  constructor(private readonly logger: HarnessLogger) {}

  private isModuleMissing(error: unknown, moduleName: string): boolean {
    if (!error || typeof error !== 'object') return false;
    const code = (error as { code?: string }).code;
    if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND') {
      return false;
    }
    const message = error instanceof Error ? error.message : String(error);
    return (
      message.includes(`'${moduleName}'`) ||
      message.includes(`"${moduleName}"`) ||
      message.includes(`Cannot find package '${moduleName}'`) ||
      message.includes(`Cannot find module '${moduleName}'`) ||
      message.includes(moduleName)
    );
  }

  private async loadOptionalModule<T>(spec: OptionalPluginSpec): Promise<T | null> {
    try {
      return await import(spec.moduleName) as T;
    } catch (error) {
      if (this.isModuleMissing(error, spec.moduleName)) {
        this.logger.info('Optional plugin module not installed; plugin disabled', {
          plugin: spec.id,
          module: spec.moduleName,
          installHint: spec.installHint,
        });
        return null;
      }
      this.logger.warning('Failed to load optional plugin module', {
        plugin: spec.id,
        module: spec.moduleName,
        error: getErrorMessage(error),
      });
      return null;
    }
  }

  async resolve<T>(spec: OptionalPluginSpec): Promise<T | null> {
    const cached = this.cache.get(spec.moduleName);
    if (cached) {
      return await cached as T | null;
    }

    const pending = this.loadOptionalModule<T>(spec);
    this.cache.set(spec.moduleName, pending as Promise<unknown | null>);
    return await pending;
  }
}
