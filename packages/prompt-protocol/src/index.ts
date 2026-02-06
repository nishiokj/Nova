export type SafeParseResult<T> =
  | { success: true; data: T }
  | { success: false; error: unknown };

export interface Validator<T> {
  parse(input: unknown): T;
  safeParse?(input: unknown): SafeParseResult<T>;
  toJSONSchema?(): unknown;
}

export type Infer<V> = V extends Validator<infer T> ? T : never;

export interface PromptMeta {
  owner?: string;
  version?: string;
  hash?: string;
  tags?: string[];
}

export interface ControlField<
  Key extends string,
  Values extends readonly string[]
> {
  readonly key: Key;
  readonly values: Values;
  inline(): string;
  describe(descriptions: Record<Values[number], string>): string;
  is(value: unknown): value is Values[number];
}

export function controlField<
  const Key extends string,
  const Values extends readonly string[]
>(key: Key, values: Values): ControlField<Key, Values> {
  const set = new Set(values as readonly string[]);
  return {
    key,
    values,
    inline() {
      return values.map((v) => JSON.stringify(v)).join(" | ");
    },
    describe(descriptions) {
      return values
        .map((v) => `- \`${v}\`: ${descriptions[v as Values[number]]}`)
        .join("\n");
    },
    is(value: unknown): value is Values[number] {
      return typeof value === "string" && set.has(value);
    },
  };
}

export function oneOf<const V extends readonly string[]>(values: V) {
  const set = new Set(values as readonly string[]);
  return (value: unknown): value is V[number] =>
    typeof value === "string" && set.has(value);
}

export type Guard<T> = (value: unknown) => value is T;

export type InferGuard<G> = G extends Guard<infer T> ? T : never;

export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const isString = (value: unknown): value is string =>
  typeof value === "string";

export const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

export const isArrayOf =
  <T>(guard: Guard<T>) =>
  (value: unknown): value is T[] =>
    Array.isArray(value) && value.every(guard);

export const optional =
  <T>(guard: Guard<T>) =>
  (value: unknown): value is T | undefined =>
    value === undefined || guard(value);

export function shape<S extends Record<string, Guard<any>>>(
  spec: S
): Guard<{ [K in keyof S]: InferGuard<S[K]> }> {
  return (value: unknown): value is { [K in keyof S]: InferGuard<S[K]> } => {
    if (!isObject(value)) return false;
    for (const key in spec) {
      const guard = spec[key];
      if (!guard((value as Record<string, unknown>)[key])) return false;
    }
    return true;
  };
}

export interface Prompt<
  Out,
  CF extends ControlField<any, any> | undefined = undefined
> {
  readonly id: string;
  readonly text: string;
  readonly meta: PromptMeta;
  readonly output: Validator<Out>;
  readonly control: CF;
  parse(raw: unknown): Out;
  safeParse(raw: unknown): SafeParseResult<Out>;
  outputJSONSchema(): unknown | undefined;
}

type ControlCompat<Out, CF extends ControlField<any, any>> =
  [Out] extends [Record<CF["key"], CF["values"][number]>]
    ? {}
    : { __control_incompatible_with_output__: never };

type PromptConfigBase<V extends Validator<any>, CF> = {
  id: string;
  text: string;
  output: V;
  meta?: PromptMeta;
  control?: CF;
};

export function prompt<
  V extends Validator<any>,
  CF extends ControlField<any, any>
>(
  config: PromptConfigBase<V, CF> &
    ControlCompat<Infer<V>, CF> & { control: CF }
): Prompt<Infer<V>, CF>;
export function prompt<V extends Validator<any>>(
  config: PromptConfigBase<V, undefined>
): Prompt<Infer<V>, undefined>;
export function prompt<
  V extends Validator<any>,
  CF extends ControlField<any, any> | undefined
>(config: PromptConfigBase<V, CF>): Prompt<Infer<V>, CF> {
  const { id, text, output, meta, control } = config;
  return {
    id,
    text,
    meta: meta ?? {},
    output,
    control: control as CF,
    parse(raw) {
      return output.parse(raw);
    },
    safeParse(raw) {
      if (output.safeParse) return output.safeParse(raw);
      try {
        return { success: true, data: output.parse(raw) };
      } catch (error) {
        return { success: false, error };
      }
    },
    outputJSONSchema() {
      return output.toJSONSchema ? output.toJSONSchema() : undefined;
    },
  };
}

export interface EventDef<
  E extends Record<Discriminant, string>,
  Discriminant extends string = "type"
> {
  readonly discriminant: Discriminant;
  readonly validate?: Validator<E>;
  handlers<R>(): (handlers: HandlersFor<EventDef<E, Discriminant>, R>) => HandlersFor<EventDef<E, Discriminant>, R>;
}

export function events<
  E extends Record<D, string>,
  D extends string = "type"
>(config?: { discriminant?: D; validate?: Validator<E> }): EventDef<E, D> {
  return {
    discriminant: (config?.discriminant ?? "type") as D,
    validate: config?.validate,
    handlers<R>() {
      return (handlers: HandlersFor<EventDef<E, D>, R>) => handlers;
    },
  };
}

export type EventOf<ED extends EventDef<any, any>> =
  ED extends EventDef<infer E, any> ? E : never;

export type TagOf<E, D extends string> = E extends Record<D, infer T>
  ? T & string
  : never;

export type TagsOf<ED extends EventDef<any, any>> = TagOf<
  EventOf<ED>,
  ED["discriminant"]
>;

export type EventFor<
  ED extends EventDef<any, any>,
  T extends TagsOf<ED>
> = Extract<EventOf<ED>, Record<ED["discriminant"], T>>;

export type HandlersFor<ED extends EventDef<any, any>, R> = {
  [T in TagsOf<ED>]: (event: EventFor<ED, T>) => R;
};

export function matchEventAll<ED extends EventDef<any, any>, R>(
  ed: ED,
  event: EventOf<ED>,
  handlers: HandlersFor<ED, R>
): R {
  const tag = event[ed.discriminant] as TagsOf<ED>;
  const fn = (handlers as unknown as Record<string, (event: EventOf<ED>) => R>)[
    tag
  ];
  if (typeof fn !== "function") {
    throw new Error(
      `No handler for ${String(tag)} (discriminant ${ed.discriminant})`
    );
  }
  return fn(event);
}

export type HandlersForEvent<
  ED extends EventDef<any, any>,
  E extends EventOf<ED>,
  R
> = ED extends EventDef<any, infer D>
  ? { [T in TagOf<E, D>]: (event: Extract<E, Record<D, T>>) => R }
  : never;

export function matchEvent<ED extends EventDef<any, any>, R>(
  ed: ED,
  event: EventOf<ED>,
  handlers: HandlersFor<ED, R>
): R;
export function matchEvent<
  ED extends EventDef<any, any>,
  E extends EventOf<ED>,
  R
>(
  ed: ED,
  event: E,
  handlers: HandlersForEvent<ED, E, R>
): R;
export function matchEvent<
  ED extends EventDef<any, any>,
  E extends EventOf<ED>,
  R
>(ed: ED, event: E, handlers: HandlersForEvent<ED, E, R>): R {
  const tag = event[ed.discriminant] as TagOf<E, ED["discriminant"]>;
  const fn = (handlers as unknown as Record<string, (event: E) => R>)[tag];
  if (typeof fn !== "function") {
    throw new Error(
      `No handler for ${String(tag)} (discriminant ${ed.discriminant})`
    );
  }
  return fn(event);
}

export type TaggedUnion<
  CF extends { key: string; values: readonly string[] },
  Payloads extends Record<CF["values"][number], object>
> = {
  [K in keyof Payloads & CF["values"][number]]:
    & { [D in CF["key"]]: K }
    & Payloads[K];
}[keyof Payloads & CF["values"][number]];

export type EnvelopeOrigin = "llm" | "hook" | "tool" | "user" | "runtime";

export type EnvelopeMeta = {
  origin: EnvelopeOrigin;
  promptId?: string;
  promptVersion?: string;
  promptHash?: string;
  controlKey?: string;
  controlValue?: string;
  timestamp: number;
  [key: string]: unknown;
};

export type EnvelopeMetaInput = Omit<EnvelopeMeta, "timestamp"> & {
  timestamp?: number;
};

export type Envelope<E> = {
  event: E;
  meta: EnvelopeMeta;
};

export function envelope<E>(event: E, meta: EnvelopeMetaInput): Envelope<E> {
  const metaWithTimestamp = {
    ...meta,
    timestamp: meta.timestamp ?? Date.now(),
  } as EnvelopeMeta;
  return {
    event,
    meta: metaWithTimestamp,
  };
}

export interface Link<
  P extends Prompt<any, any>,
  ED extends EventDef<any, any>,
  Emit extends TagsOf<ED> = TagsOf<ED>
> {
  readonly prompt: P;
  readonly events: ED;
  readonly emit?: readonly Emit[];
  toEvent(
    output: Infer<P["output"]>
  ): Extract<EventOf<ED>, Record<ED["discriminant"], Emit>>;
  toEnvelope(
    output: Infer<P["output"]>,
    meta: EnvelopeMetaInput
  ): Envelope<Extract<EventOf<ED>, Record<ED["discriminant"], Emit>>>;
}

type LinkMap<
  P extends Prompt<any, ControlField<any, any>>,
  ED extends EventDef<any, any>,
  Emit extends TagsOf<ED>
> = {
  [V in P["control"]["values"][number]]:
    | Extract<EventOf<ED>, Record<ED["discriminant"], Emit>>
    | ((
        output: Infer<P["output"]>
      ) => Extract<EventOf<ED>, Record<ED["discriminant"], Emit>>);
};

export function link<
  P extends Prompt<any, ControlField<any, any>>,
  ED extends EventDef<any, any>,
  Emit extends TagsOf<ED> = TagsOf<ED>
>(
  prompt: P,
  events: ED,
  config: {
    emit?: readonly Emit[];
    map: LinkMap<P, ED, Emit>;
    meta?: { owner?: string; version?: string };
  }
): Link<P, ED, Emit>;
export function link<
  P extends Prompt<any, undefined>,
  ED extends EventDef<any, any>,
  Emit extends TagsOf<ED> = TagsOf<ED>
>(
  prompt: P,
  events: ED,
  config: {
    emit?: readonly Emit[];
    toEvent: (output: Infer<P["output"]>) => Extract<
      EventOf<ED>,
      Record<ED["discriminant"], Emit>
    >;
  }
): Link<P, ED, Emit>;
export function link<
  P extends Prompt<any, any>,
  ED extends EventDef<any, any>,
  Emit extends TagsOf<ED>
>(
  prompt: P,
  events: ED,
  config:
    | {
        emit?: readonly Emit[];
        map: LinkMap<any, ED, Emit>;
        meta?: { owner?: string; version?: string };
      }
    | {
        emit?: readonly Emit[];
        toEvent: (output: any) => Extract<
          EventOf<ED>,
          Record<ED["discriminant"], Emit>
        >;
      }
): Link<P, ED, Emit> {
  if ("map" in config) {
    const toEvent = (output: Infer<P["output"]>) => {
      const control = (prompt as Prompt<any, ControlField<any, any>>).control;
      if (!control) {
        throw new Error(`Prompt ${prompt.id} has no control field`);
      }
      const key = control.key;
      const value = (output as Record<string, unknown>)[key];
      if (typeof value !== "string") {
        throw new Error(
          `Invalid control value for ${prompt.id}.${key}=${JSON.stringify(value)}`
        );
      }
      const entry = (config.map as Record<string, any>)[value];
      if (entry === undefined) {
        throw new Error(
          `No link mapping for control ${prompt.id}.${key}=${JSON.stringify(value)}`
        );
      }
      return typeof entry === "function" ? entry(output) : entry;
    };
    return {
      prompt,
      events,
      emit: config.emit,
      toEvent,
      toEnvelope(output, meta) {
        const control = (prompt as Prompt<any, ControlField<any, any>>).control;
        const controlValue = control
          ? (output as Record<string, unknown>)[control.key]
          : undefined;
        const event = toEvent(output);
        return envelope(event, {
          promptId: prompt.id,
          promptVersion: prompt.meta.version,
          promptHash: prompt.meta.hash,
          controlKey: control?.key,
          controlValue,
          ...meta,
        });
      },
    };
  }

  const toEvent = config.toEvent;
  return {
    prompt,
    events,
    emit: config.emit,
    toEvent,
    toEnvelope(output, meta) {
      const event = toEvent(output);
      return envelope(event, {
        promptId: prompt.id,
        promptVersion: prompt.meta.version,
        promptHash: prompt.meta.hash,
        ...meta,
      });
    },
  };
}

export interface Protocol<
  Routes extends string,
  ED extends EventDef<any, any>,
  R
> {
  readonly id: string;
  readonly events: ED;
  route(name: Routes): { prompt: Prompt<any, any> };
  handle(event: EventOf<ED>): R;
  toEvent(name: Routes, raw: unknown): EventOf<ED>;
  process(name: Routes, raw: unknown): R;
}

export function protocol<
  Routes extends string,
  ED extends EventDef<any, any>,
  R
>(config: {
  id: string;
  events: ED;
  routes: Record<
    Routes,
    Prompt<EventOf<ED>, any> | Link<Prompt<any, any>, ED, any>
  >;
  handlers: HandlersFor<ED, R>;
  meta?: { owner?: string; version?: string };
}): Protocol<Routes, ED, R> {
  const { id, events, routes, handlers } = config;
  return {
    id,
    events,
    route(name) {
      const route = routes[name];
      if ("toEvent" in route) return { prompt: route.prompt };
      return { prompt: route };
    },
    handle(event) {
      return matchEvent(events, event, handlers);
    },
    toEvent(name, raw) {
      const route = routes[name];
      if ("toEvent" in route) {
        const out = route.prompt.parse(raw);
        return route.toEvent(out) as EventOf<ED>;
      }
      return route.parse(raw) as EventOf<ED>;
    },
    process(name, raw) {
      const ev = this.toEvent(name, raw);
      return matchEvent(events, ev, handlers);
    },
  };
}
