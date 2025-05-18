/**
 * Logger system for WARP Player
 * Inspired by the dash.js logging system
 */

export enum LogLevel {
  NONE = 0,
  FATAL = 1,
  ERROR = 2,
  WARNING = 3,
  INFO = 4,
  DEBUG = 5
}

export interface LoggerConfig {
  level: LogLevel;
  showTimestamp: boolean;
  showCategory: boolean;
  dispatchEvents: boolean;
  useConsoleOnly: boolean;
}

export interface ILogger {
  debug(message: string, ...args: any[]): void;
  info(message: string, ...args: any[]): void;
  warn(message: string, ...args: any[]): void;
  error(message: string, ...args: any[]): void;
  fatal(message: string, ...args: any[]): void;
  getCategory(): string;
  setLevel(level: LogLevel): void;
}

export class Logger implements ILogger {
  private category: string;
  private config: LoggerConfig;
  private startTime: number;

  constructor(category: string, config: LoggerConfig) {
    this.category = category;
    this.config = config;
    this.startTime = performance.now();
  }
  
  public setLevel(level: LogLevel): void {
    this.config.level = level;
  }

  public getCategory(): string {
    return this.category;
  }

  private formatMessage(level: string, message: string): string {
    const parts = [];
    
    if (this.config.showTimestamp) {
      const elapsed = ((performance.now() - this.startTime) / 1000).toFixed(3);
      parts.push(`[${elapsed}s]`);
    }
    
    if (this.config.showCategory) {
      parts.push(`[${this.category}]`);
    }
    
    parts.push(`[${level}]`);
    parts.push(message);
    
    return parts.join(' ');
  }

  debug(message: string, ...args: any[]): void {
    if (this.config.level >= LogLevel.DEBUG) {
      console.debug(this.formatMessage('DEBUG', message), ...args);
      this.dispatchEvent('debug', message, args);
    }
  }

  info(message: string, ...args: any[]): void {
    if (this.config.level >= LogLevel.INFO) {
      console.info(this.formatMessage('INFO', message), ...args);
      this.dispatchEvent('info', message, args);
    }
  }

  warn(message: string, ...args: any[]): void {
    if (this.config.level >= LogLevel.WARNING) {
      console.warn(this.formatMessage('WARN', message), ...args);
      this.dispatchEvent('warn', message, args);
    }
  }

  error(message: string, ...args: any[]): void {
    if (this.config.level >= LogLevel.ERROR) {
      console.error(this.formatMessage('ERROR', message), ...args);
      this.dispatchEvent('error', message, args);
    }
  }

  fatal(message: string, ...args: any[]): void {
    if (this.config.level >= LogLevel.FATAL) {
      console.error(this.formatMessage('FATAL', message), ...args);
      this.dispatchEvent('fatal', message, args);
    }
  }

  private dispatchEvent(level: string, message: string, args: any[]): void {
    if (this.config.dispatchEvents && typeof window !== 'undefined' && !this.config.useConsoleOnly) {
      try {
        window.dispatchEvent(new CustomEvent('warp-log', {
          detail: {
            level,
            category: this.category,
            message,
            args,
            timestamp: performance.now()
          }
        }));
      } catch (e) {
        console.error(`Error dispatching log event: ${e}`);
      }
    }
  }
}

/**
 * Singleton logger factory for WARP Player
 */
export class LoggerFactory {
  private static instance: LoggerFactory;
  private config: LoggerConfig;
  private categoryLevels: Map<string, LogLevel> = new Map();
  private loggers: Map<string, Logger> = new Map();
  
  private constructor() {
    // Default configuration
    this.config = {
      level: LogLevel.WARNING,
      showTimestamp: true,
      showCategory: true,
      dispatchEvents: false,
      useConsoleOnly: false
    };
  }

  public static getInstance(): LoggerFactory {
    if (!LoggerFactory.instance) {
      LoggerFactory.instance = new LoggerFactory();
    }
    return LoggerFactory.instance;
  }

  public setGlobalLogLevel(level: LogLevel): void {
    this.config.level = level;
    
    // Update all existing loggers
    this.loggers.forEach(logger => {
      // Only update if the logger doesn't have a category-specific level
      if (!this.categoryLevels.has(logger.getCategory())) {
        (logger as any).config.level = level;
      }
    });
  }

  public getGlobalLogLevel(): LogLevel {
    return this.config.level;
  }

  public getCategoryLogLevel(category: string): LogLevel {
    return this.categoryLevels.get(category) || this.config.level;
  }

  public setCategoryLogLevel(category: string, level: LogLevel): void {
    this.categoryLevels.set(category, level);
    
    // Update existing logger if it exists
    if (this.loggers.has(category)) {
      const logger = this.loggers.get(category);
      if (logger) {
        (logger as any).config.level = level;
      }
    }
  }

  public getLogger(category: string): ILogger {
    if (!this.loggers.has(category)) {
      // Create a new config for this category
      const categoryConfig = {...this.config};
      
      // Override with category-specific level if set
      if (this.categoryLevels.has(category)) {
        categoryConfig.level = this.categoryLevels.get(category) as LogLevel;
      }
      
      // Create and store logger
      const logger = new Logger(category, categoryConfig);
      this.loggers.set(category, logger);
    }
    
    return this.loggers.get(category) as ILogger;
  }

  public setShowTimestamp(show: boolean): void {
    this.config.showTimestamp = show;
    // Update all existing loggers
    this.loggers.forEach(logger => {
      (logger as any).config.showTimestamp = show;
    });
  }

  public setShowCategory(show: boolean): void {
    this.config.showCategory = show;
    // Update all existing loggers
    this.loggers.forEach(logger => {
      (logger as any).config.showCategory = show;
    });
  }

  public setDispatchEvents(dispatch: boolean): void {
    this.config.dispatchEvents = dispatch;
    // Update all existing loggers
    this.loggers.forEach(logger => {
      (logger as any).config.dispatchEvents = dispatch;
    });
  }
  
  public setUseConsoleOnly(useConsoleOnly: boolean): void {
    this.config.useConsoleOnly = useConsoleOnly;
    // Update all existing loggers
    this.loggers.forEach(logger => {
      (logger as any).config.useConsoleOnly = useConsoleOnly;
    });
  }
  
  public isConsoleOnly(): boolean {
    return this.config.useConsoleOnly;
  }

  public getLoggerCategories(): string[] {
    return Array.from(this.loggers.keys());
  }

  public reset(): void {
    this.config = {
      level: LogLevel.WARNING,
      showTimestamp: true,
      showCategory: true,
      dispatchEvents: false,
      useConsoleOnly: false
    };
    this.categoryLevels.clear();
    
    // Reset all loggers to default settings
    this.loggers.forEach(logger => {
      (logger as any).config = {...this.config};
    });
  }
  
  public resetComponentLevels(): void {
    // Clear category-specific levels
    this.categoryLevels.clear();
    
    // Reset all loggers to use the global log level
    const globalLevel = this.config.level;
    this.loggers.forEach(logger => {
      (logger as any).config.level = globalLevel;
    });
  }
}

// Export default instance for easy access
export const loggerFactory = LoggerFactory.getInstance();