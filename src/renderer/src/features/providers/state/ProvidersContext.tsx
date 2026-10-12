// Copyright 2026 Scrakk Studio
// SPDX-License-Identifier: Apache-2.0
// Licencia completa en LICENSE (Apache License 2.0).

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from 'react'
import type { ThinkingMode } from '@shared/thinking'
import type { SecretWriteResult } from '@shared/secrets'
import { getProvider, getProviders, subscribeProviderCatalog, type ProviderConfig } from '@services/providers'
import { PROVIDERS_STORAGE_KEY } from '../settings'

import { t } from '@core/i18n'
const STORAGE_KEY = PROVIDERS_STORAGE_KEY

interface StoredProvidersState {
  activeProviderId: string | null
  /**
   * Solo LEGADO: keys que quedaron en localStorage antes de B4. Se migran al
   * store cifrado del main al arrancar y luego se borran de aquí.
   */
  apiKeys: Record<string, string>
  /** Modelo elegido por proveedor (id exacto). Vacío = defaultModel del config. */
  models: Record<string, string>
  /** Modo de pensamiento elegido por proveedor ('auto' si no está). */
  thinkingModes: Record<string, string>
  /** Variante de razonamiento elegida por proveedor (`/variants`). */
  variants: Record<string, string>
}

const EMPTY_STORED: StoredProvidersState = {
  activeProviderId: null,
  apiKeys: {},
  models: {},
  thinkingModes: {},
  variants: {}
}

function loadStoredState(): StoredProvidersState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return EMPTY_STORED
    const parsed = JSON.parse(raw) as Partial<StoredProvidersState>
    return {
      activeProviderId: typeof parsed.activeProviderId === 'string' ? parsed.activeProviderId : null,
      apiKeys:
        typeof parsed.apiKeys === 'object' && parsed.apiKeys !== null ? parsed.apiKeys : {},
      models:
        typeof parsed.models === 'object' && parsed.models !== null ? parsed.models : {},
      thinkingModes:
        typeof parsed.thinkingModes === 'object' && parsed.thinkingModes !== null
          ? parsed.thinkingModes
          : {},
      variants:
        typeof parsed.variants === 'object' && parsed.variants !== null ? parsed.variants : {}
    }
  } catch {
    return EMPTY_STORED
  }
}

interface ProvidersContextValue {
  /** Proveedores detectados automáticamente (registry). */
  providers: ProviderConfig[]
  activeProviderId: string | null
  /** Proveedor activo resuelto (null si no hay ninguno seleccionado). */
  activeProvider: ProviderConfig | null
  /** ¿Hay una API key guardada para el proveedor? (el valor nunca sale del main). */
  hasApiKey: (providerId: string) => boolean
  /** Modelo elegido de un proveedor (fallback: defaultModel del config). */
  getModel: (providerId: string) => string
  /** Modo de pensamiento elegido de un proveedor (fallback: 'auto'). */
  getThinkingMode: (providerId: string) => ThinkingMode
  /** Variante de razonamiento elegida (`/variants`); '' si no hay. */
  getVariant: (providerId: string) => string
  /** Guarda la variante de razonamiento del proveedor. */
  setVariant: (providerId: string, variant: string | null) => void
  /** Selecciona el proveedor activo (debe tener key para poder chatear). */
  selectProvider: (providerId: string) => void
  /** Guarda la key cifrada en el main. Activa el proveedor si la guardó. */
  setApiKey: (providerId: string, apiKey: string) => Promise<SecretWriteResult>
  /** Elimina la key guardada. */
  removeApiKey: (providerId: string) => Promise<SecretWriteResult>
  /** Guarda el modelo elegido del proveedor (persistido en localStorage). */
  setModel: (providerId: string, modelId: string) => void
  /** Guarda el modo de pensamiento del proveedor (persistido en localStorage). */
  setThinkingMode: (providerId: string, mode: ThinkingMode) => void
  /** Estado del modal de proveedores (se abre desde el menú o el picker). */
  isProvidersModalOpen: boolean
  openProvidersModal: () => void
  closeProvidersModal: () => void
}

const ProvidersContext = createContext<ProvidersContextValue | null>(null)

/**
 * Estado real de los proveedores de LLM: el proveedor activo y sus API keys.
 * Se detectan solos desde `services/providers` (import.meta.glob); aquí solo
 * se elige cuál usar y se guardan las keys localmente.
 */
export function ProvidersProvider({ children }: { children: ReactNode }) {
  // Una sola lectura de localStorage (el lazy init corre una única vez).
  const [stored] = useState(loadStoredState)
  const [activeProviderId, setActiveProviderId] = useState<string | null>(() =>
    // Si el proveedor guardado ya no existe en el registro, arranca sin activo.
    stored.activeProviderId && getProvider(stored.activeProviderId) ? stored.activeProviderId : null
  )
  // Ids con key guardada en el main. El valor de la key nunca entra al renderer.
  const [keyIds, setKeyIds] = useState<string[]>([])
  // Keys legacy pendientes de migrar (se vacían cuando el main las acepta).
  const [legacyKeys, setLegacyKeys] = useState<Record<string, string>>(stored.apiKeys)
  const [models, setModels] = useState<Record<string, string>>(stored.models)
  const [thinkingModes, setThinkingModes] = useState<Record<string, string>>(stored.thinkingModes)
  const [variants, setVariants] = useState<Record<string, string>>(stored.variants)
  const [isProvidersModalOpen, setIsProvidersModalOpen] = useState(false)
  // Catálogo de proveedores (models.dev): llega async y se refresca en cada
  // apertura; la lista re-renderiza a todos los consumidores.
  const [providers, setProviders] = useState<ProviderConfig[]>(() => getProviders())

  useEffect(() => subscribeProviderCatalog(() => setProviders(getProviders())), [])

  // El comando `/variants` (y cualquier subsistema sin React) escribe la
  // variante por evento; acá se re-sincroniza el estado.
  useEffect(() => {
    const onSetVariant = (event: Event): void => {
      const detail = (event as CustomEvent<{ providerId?: string; variant?: string | null }>).detail
      if (!detail?.providerId) return
      setVariants((prev) => {
        const next = { ...prev }
        if (detail.variant) next[detail.providerId!] = detail.variant
        else delete next[detail.providerId!]
        return next
      })
    }
    window.addEventListener('providers:set-variant', onSetVariant)
    return () => window.removeEventListener('providers:set-variant', onSetVariant)
  }, [])

  // Cuando el catálogo llega, restaura el proveedor activo guardado.
  useEffect(() => {
    if (activeProviderId === null && stored.activeProviderId && getProvider(stored.activeProviderId)) {
      setActiveProviderId(stored.activeProviderId)
    }
  }, [providers, activeProviderId, stored.activeProviderId])

  // Carga de ids y migración única de keys legacy (localStorage → store cifrado).
  // Solo se quita una key de localStorage cuando el main la guardó.
  useEffect(() => {
    const secrets = window.api?.secrets
    if (!secrets) return
    let cancelled = false
    void (async () => {
      const remaining: Record<string, string> = {}
      for (const [id, key] of Object.entries(stored.apiKeys)) {
        if (!key.trim()) continue
        const res = await secrets.setProviderKey(id, key).catch(() => ({ ok: false as const, reason: 'io' as const }))
        if (!res.ok) remaining[id] = key
      }
      const ids = await secrets.listProviderKeys().catch(() => [] as string[])
      if (cancelled) return
      setLegacyKeys(remaining)
      setKeyIds(ids)
    })()
    return () => {
      cancelled = true
    }
  }, [stored.apiKeys])

  // Persistencia: cada cambio se guarda solo. Las keys van al store cifrado; las
  // que no se pudieron migrar siguen en localStorage (no se pierden).
  useEffect(() => {
    const stored: StoredProvidersState = {
      activeProviderId,
      apiKeys: legacyKeys,
      models,
      thinkingModes,
      variants
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stored))
    } catch {
      // Almacenamiento no disponible: se sigue en memoria nomás.
    }
  }, [activeProviderId, legacyKeys, models, thinkingModes, variants])

  const activeProvider = useMemo(
    () => (activeProviderId ? getProvider(activeProviderId) : null),
    [activeProviderId, providers]
  )

  const hasApiKey = useCallback((providerId: string): boolean => keyIds.includes(providerId), [keyIds])

  const getModel = useCallback(
    (providerId: string): string => {
      const config = getProvider(providerId)
      const stored = models[providerId]
      // Un id guardado que no está en el catálogo se ignora (cae al default):
      // evita quedar pegado a un id viejo que el proveedor rechaza con 400.
      if (stored && config?.models && config.models.length > 0 && !config.models.includes(stored)) {
        return config.defaultModel
      }
      return stored ?? config?.defaultModel ?? ''
    },
    [models, providers]
  )

  const getThinkingMode = useCallback(
    (providerId: string): ThinkingMode => {
      const mode = thinkingModes[providerId]
      return mode === 'auto' || mode === 'off' || mode === 'low' || mode === 'medium' ||
        mode === 'high' || mode === 'on'
        ? mode
        : 'auto'
    },
    [thinkingModes]
  )

  const selectProvider = useCallback((providerId: string) => {
    setActiveProviderId(providerId)
  }, [])

  const setApiKey = useCallback(async (providerId: string, apiKey: string): Promise<SecretWriteResult> => {
    const key = apiKey.trim()
    if (!key) return { ok: false, reason: 'io' }
    const res = await window.api.secrets.setProviderKey(providerId, key)
    if (res.ok) {
      setKeyIds((prev) => (prev.includes(providerId) ? prev : [...prev, providerId]))
      setActiveProviderId(providerId)
    }
    return res
  }, [])

  const removeApiKey = useCallback(async (providerId: string): Promise<SecretWriteResult> => {
    const res = await window.api.secrets.deleteProviderKey(providerId)
    if (res.ok) setKeyIds((prev) => prev.filter((id) => id !== providerId))
    return res
    })
    // Si era el proveedor activo, sin key no puede chatear → se desactiva.
    setActiveProviderId((prev) => (prev === providerId ? null : prev))
  }, [])

  const setModel = useCallback((providerId: string, modelId: string) => {
    setModels((prev) => ({ ...prev, [providerId]: modelId }))
  }, [])

  const setThinkingMode = useCallback((providerId: string, mode: ThinkingMode) => {
    setThinkingModes((prev) => ({ ...prev, [providerId]: mode }))
  }, [])

  const getVariant = useCallback(
    (providerId: string): string => variants[providerId] ?? '',
    [variants]
  )

  const setVariant = useCallback((providerId: string, variant: string | null) => {
    setVariants((prev) => {
      const next = { ...prev }
      if (variant) next[providerId] = variant
      else delete next[providerId]
      return next
    })
  }, [])

  // "Abrir proveedores" ahora lleva a Ajustes → Chat → Proveedores (el modal
  // viejo fue reemplazado por la sección).
  const openProvidersModal = useCallback(() => {
    window.dispatchEvent(new CustomEvent('open-settings', { detail: { section: 'chatProviders' } }))
  }, [])
  const closeProvidersModal = useCallback(() => setIsProvidersModalOpen(false), [])

  const value = useMemo(
    () => ({
      providers,
      activeProviderId,
      activeProvider,
      hasApiKey,
      getModel,
      getThinkingMode,
      getVariant,
      setVariant,
      selectProvider,
      setApiKey,
      removeApiKey,
      setModel,
      setThinkingMode,
      isProvidersModalOpen,
      openProvidersModal,
      closeProvidersModal
    }),
    [
      providers,
      activeProviderId,
      activeProvider,
      hasApiKey,
      getModel,
      getThinkingMode,
      getVariant,
      setVariant,
      selectProvider,
      setApiKey,
      removeApiKey,
      setModel,
      setThinkingMode,
      isProvidersModalOpen,
      openProvidersModal,
      closeProvidersModal
    ]
  )

  return <ProvidersContext.Provider value={value}>{children}</ProvidersContext.Provider>
}

export function useProviders(): ProvidersContextValue {
  const context = useContext(ProvidersContext)
  if (!context) {
    throw new Error(t('providers.useproviders.debe.usarse.dentro.de'))
  }
  return context
}
