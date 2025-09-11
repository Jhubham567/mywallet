"use client"

import { useState, useEffect } from "react"
import { useMutation, useQuery } from "convex/react"
import { api } from "@/convex/_generated/api"
import { useConvexAuth } from "./use-convex-auth"
import { useWalletData } from "@/contexts/wallet-data-context"
import { SecureWallet } from "@/lib/security"
import { toast } from "@/hooks/use-toast"

interface SyncState {
  isEnabled: boolean
  isPaused: boolean
  isSyncing: boolean
  lastSyncTime: number | null
  error: string | null
}

interface DeviceInfo {
  deviceId: string
  deviceName: string
  lastSyncAt: number
  syncVersion: string
  isActive: boolean
  isCurrentDevice: boolean
}

export function useConvexSync() {
  const { user, isAuthenticated, isLoading: authLoading } = useConvexAuth()
  const { userProfile, transactions, budgets, goals, debtAccounts, creditAccounts, debtCreditTransactions, categories, emergencyFund, importData } = useWalletData()

  const [syncState, setSyncState] = useState<SyncState>({
    isEnabled: false,
    isPaused: false,
    isSyncing: false,
    lastSyncTime: null,
    error: null,
  })

  // Load sync settings from localStorage
  useEffect(() => {
    const isEnabled = localStorage.getItem("convex_sync_enabled") === "true"
    const lastSyncTime = localStorage.getItem("convex_last_sync_time")

    setSyncState(prev => ({
      ...prev,
      isEnabled,
      lastSyncTime: lastSyncTime ? parseInt(lastSyncTime) : null,
    }))
  }, [])

  // Auto-enable sync when user signs in (DEFAULT BEHAVIOR)
  useEffect(() => {
    if (isAuthenticated && !syncState.isEnabled && !syncState.isSyncing) {
      console.log('[useConvexSync] Auto-enabling sync for authenticated user (default behavior)')
      enableSync() // Always enable sync by default for authenticated users
    }
  }, [isAuthenticated, syncState.isEnabled, syncState.isSyncing])

  // Debug logging
  useEffect(() => {
    console.log('[useConvexSync] Auth state:', { user, isAuthenticated, authLoading })
  }, [user, isAuthenticated, authLoading])

  const storeWalletDataMutation = useMutation(api.walletData.storeWalletData)
  const getLatestWalletData = useQuery(
    api.walletData.getLatestWalletData,
    isAuthenticated && user?.id ? { userId: user.id as any } : "skip"
  )
  const getWalletData = useQuery(
    api.walletData.getWalletData,
    isAuthenticated && user?.id ? { userId: user.id as any } : "skip"
  )
  const updateSyncMetadataMutation = useMutation(api.walletData.updateSyncMetadata)

  // Auto-sync from Convex when component mounts and sync is enabled
  useEffect(() => {
    if (isAuthenticated && syncState.isEnabled && !syncState.isSyncing && getLatestWalletData) {
      console.log('[useConvexSync] Auto-syncing from Convex on mount')
      // Only sync from Convex if we have data there and it's newer than our last sync
      const lastSyncTime = localStorage.getItem("convex_last_sync_time")
      const convexDataTime = getLatestWalletData.lastModified

      if (!lastSyncTime || (convexDataTime && convexDataTime > parseInt(lastSyncTime))) {
        syncFromConvex()
      }
    }
  }, [isAuthenticated, syncState.isEnabled, syncState.isSyncing, getLatestWalletData])

  // Generate user-friendly device name
  const getDeviceInfo = () => {
    let deviceId = localStorage.getItem("convex_device_id")
    let deviceName = localStorage.getItem("convex_device_name")

    if (!deviceId) {
      deviceId = `device_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
      localStorage.setItem("convex_device_id", deviceId)
    }

    if (!deviceName) {
      // Generate user-friendly device name
      const userAgent = navigator.userAgent
      let browser = "Browser"
      let os = "Device"

      // Detect browser
      if (userAgent.includes("Chrome")) browser = "Chrome"
      else if (userAgent.includes("Firefox")) browser = "Firefox"
      else if (userAgent.includes("Safari") && !userAgent.includes("Chrome")) browser = "Safari"
      else if (userAgent.includes("Edge")) browser = "Edge"

      // Detect OS
      if (userAgent.includes("Windows")) os = "Windows"
      else if (userAgent.includes("Mac")) os = "macOS"
      else if (userAgent.includes("Linux")) os = "Linux"
      else if (userAgent.includes("Android")) os = "Android"
      else if (userAgent.includes("iPhone") || userAgent.includes("iPad")) os = "iOS"

      deviceName = `${browser} on ${os}`
      localStorage.setItem("convex_device_name", deviceName)
    }

    return { deviceId, deviceName }
  }

  // Generate consistent salt from user data
  const generateConsistentSalt = (userId: string, userEmail: string): Uint8Array => {
    // Create a deterministic salt based on user data
    const userData = `${userId}_${userEmail}_convex_sync_salt`
    const encoder = new TextEncoder()
    const data = encoder.encode(userData)

    // Use SHA-256 to create a consistent 32-byte salt
    return new Uint8Array(data.slice(0, 32))
  }

  // Encrypt wallet data
  const encryptWalletData = async (data: any, password: string) => {
    try {
      const dataString = JSON.stringify(data)
      // Use consistent salt based on user data for cross-device compatibility
      const salt = generateConsistentSalt(user!.id, user!.email)
      const key = await SecureWallet.deriveKeyFromPin(password, salt)
      const encrypted = await SecureWallet.encryptData(dataString, key)
      const hash = await SecureWallet.generateIntegrityHash(dataString)
      return { encrypted, hash }
    } catch (error) {
      throw new Error("Encryption failed")
    }
  }

  // Decrypt wallet data
  const decryptWalletData = async (encryptedData: string, password: string) => {
    try {
      // Use the same consistent salt as encryption
      const salt = generateConsistentSalt(user!.id, user!.email)
      const key = await SecureWallet.deriveKeyFromPin(password, salt)
      const decrypted = await SecureWallet.decryptData(encryptedData, key)
      return JSON.parse(decrypted)
    } catch (error) {
      throw new Error("Decryption failed")
    }
  }

  // Enable Convex sync (automatically when user signs in)
  const enableSync = async () => {
    // Wait for auth to be fully loaded with timeout
    let attempts = 0
    const maxAttempts = 50 // 5 seconds max wait

    while (authLoading && attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 100))
      attempts++
    }

    if (!isAuthenticated || !user) {
      console.error('[enableSync] Auth check failed after waiting:', { isAuthenticated, user, authLoading })
      // Don't throw error, just return success false to allow retry
      return { success: false, error: "User not authenticated" }
    }

    try {
      setSyncState(prev => ({ ...prev, isSyncing: true, error: null }))

      // Generate consistent password from user data for encryption
      const syncPassword = `convex_sync_${user.id}_${user.email}`

      // Perform initial sync - don't fail if this fails
      try {
        await syncToConvex(syncPassword)
      } catch (syncError) {
        console.warn('[enableSync] Initial sync failed, but continuing:', syncError)
        // Don't fail the entire enable process for sync issues
      }

      // Update settings
      localStorage.setItem("convex_sync_enabled", "true")
      setSyncState(prev => ({
        ...prev,
        isEnabled: true,
        isSyncing: false,
      }))

      console.log('[enableSync] Sync enabled successfully')
      return { success: true }
    } catch (error: any) {
      console.error('[enableSync] Failed to enable sync:', error)
      setSyncState(prev => ({
        ...prev,
        isSyncing: false,
        error: error.message || "Failed to enable sync",
      }))

      return { success: false, error: error.message }
    }
  }

  // Disable Convex sync
  const disableSync = async () => {
    try {
      // Clear sync data
      localStorage.removeItem("convex_sync_enabled")
      localStorage.removeItem("convex_sync_password")
      localStorage.removeItem("convex_last_sync_time")

      setSyncState({
        isEnabled: false,
        isPaused: false,
        isSyncing: false,
        lastSyncTime: null,
        error: null,
      })

      toast({
        title: "Convex Sync Disabled",
        description: "Sync has been disabled. Your data will no longer sync to Convex.",
      })

      return { success: true }
    } catch (error: any) {
      toast({
        title: "Error",
        description: "Failed to disable sync",
        variant: "destructive",
      })

      return { success: false, error: error.message }
    }
  }

  // Sync data to Convex
  const syncToConvex = async (password?: string) => {
    if (!isAuthenticated || !user || !syncState.isEnabled) {
      return { success: false, error: "Sync not enabled or user not authenticated" }
    }

    // Use provided password or generate one from user ID for consistency
    const syncPassword = password || `convex_sync_${user.id}_${user.email}`

    try {
      setSyncState(prev => ({ ...prev, isSyncing: true, error: null }))

      // Prepare wallet data - EXCLUDE default categories
      const userCreatedCategories = categories.filter(cat => !cat.isDefault)

      const walletData = {
        userProfile,
        transactions,
        budgets,
        goals,
        debtAccounts,
        creditAccounts,
        categories: userCreatedCategories, // Only sync user-created categories
        emergencyFund,
        exportedAt: Date.now(),
      }

      // Encrypt data
      const { encrypted, hash } = await encryptWalletData(walletData, syncPassword)

      // Store in Convex
      const { deviceId, deviceName } = getDeviceInfo()
      await storeWalletDataMutation({
        userId: user.id as any,
        deviceId,
        encryptedData: encrypted,
        dataHash: hash,
        version: "1.0",
      })

      // Update sync metadata
      await updateSyncMetadataMutation({
        userId: user.id as any,
        deviceId,
        deviceName,
        syncVersion: "1.0",
      })

      const now = Date.now()
      localStorage.setItem("convex_last_sync_time", now.toString())

      setSyncState(prev => ({
        ...prev,
        isSyncing: false,
        lastSyncTime: now,
      }))

      return { success: true }
    } catch (error: any) {
      setSyncState(prev => ({
        ...prev,
        isSyncing: false,
        error: error.message || "Sync failed",
      }))

      return { success: false, error: error.message }
    }
  }

  // Smart merge function for conflict resolution
  const mergeWalletData = (localData: any, remoteData: any) => {
    const merged = { ...localData }
    const conflicts: any[] = []
    const mergeLog: string[] = []

    // Helper function to get timestamp
    const getTimestamp = (item: any) => item?.lastModified || item?.timeEquivalent || item?.createdAt || 0

    // Merge transactions (always combine, no loss)
    if (remoteData.transactions && Array.isArray(remoteData.transactions)) {
      const localTransactions = localData.transactions || []
      const remoteTransactions = remoteData.transactions

      // Create maps for efficient lookup
      const localMap = new Map(localTransactions.map((t: any) => [t.id, t]))
      const remoteMap = new Map(remoteTransactions.map((t: any) => [t.id, t]))

      // Merge transactions
      const mergedTransactions = []

      // Add all local transactions
      for (const local of localTransactions) {
        mergedTransactions.push(local)
      }

      // Add remote transactions that don't exist locally
      for (const remote of remoteTransactions) {
        if (!localMap.has(remote.id)) {
          mergedTransactions.push(remote)
          mergeLog.push(`Added transaction: ${remote.description} (${remote.amount})`)
        } else {
          // Check which version is newer
          const localVersion = localMap.get(remote.id)
          if (getTimestamp(remote) > getTimestamp(localVersion)) {
            // Replace with newer version
            const index = mergedTransactions.findIndex((t: any) => t.id === remote.id)
            if (index !== -1) {
              mergedTransactions[index] = remote
              mergeLog.push(`Updated transaction: ${remote.description}`)
            }
          }
        }
      }

      merged.transactions = mergedTransactions
    }

    // Merge budgets (combine all)
    if (remoteData.budgets && Array.isArray(remoteData.budgets)) {
      const localBudgets = localData.budgets || []
      const remoteBudgets = remoteData.budgets

      const localMap = new Map(localBudgets.map((b: any) => [b.id, b]))
      const mergedBudgets = [...localBudgets]

      for (const remote of remoteBudgets) {
        if (!localMap.has(remote.id)) {
          mergedBudgets.push(remote)
          mergeLog.push(`Added budget: ${remote.name}`)
        } else if (getTimestamp(remote) > getTimestamp(localMap.get(remote.id))) {
          const index = mergedBudgets.findIndex((b: any) => b.id === remote.id)
          if (index !== -1) {
            mergedBudgets[index] = remote
            mergeLog.push(`Updated budget: ${remote.name}`)
          }
        }
      }

      merged.budgets = mergedBudgets
    }

    // Merge goals (combine all)
    if (remoteData.goals && Array.isArray(remoteData.goals)) {
      const localGoals = localData.goals || []
      const remoteGoals = remoteData.goals

      const localMap = new Map(localGoals.map((g: any) => [g.id, g]))
      const mergedGoals = [...localGoals]

      for (const remote of remoteGoals) {
        if (!localMap.has(remote.id)) {
          mergedGoals.push(remote)
          mergeLog.push(`Added goal: ${remote.name}`)
        } else if (getTimestamp(remote) > getTimestamp(localMap.get(remote.id))) {
          const index = mergedGoals.findIndex((g: any) => g.id === remote.id)
          if (index !== -1) {
            mergedGoals[index] = remote
            mergeLog.push(`Updated goal: ${remote.name}`)
          }
        }
      }

      merged.goals = mergedGoals
    }

    // Merge categories (ONLY user-created, exclude defaults)
    if (remoteData.categories && Array.isArray(remoteData.categories)) {
      const localCategories = localData.categories || []
      const remoteCategories = remoteData.categories

      // Filter out default categories from both local and remote
      const localUserCategories = localCategories.filter((c: any) => !c.isDefault)
      const remoteUserCategories = remoteCategories.filter((c: any) => !c.isDefault)

      const localMap = new Map(localUserCategories.map((c: any) => [c.id, c]))
      const mergedCategories = [...localUserCategories]

      for (const remote of remoteUserCategories) {
        if (!localMap.has(remote.id)) {
          mergedCategories.push(remote)
          mergeLog.push(`Added user category: ${remote.name}`)
        } else if (getTimestamp(remote) > getTimestamp(localMap.get(remote.id))) {
          const index = mergedCategories.findIndex((c: any) => c.id === remote.id)
          if (index !== -1) {
            mergedCategories[index] = remote
            mergeLog.push(`Updated user category: ${remote.name}`)
          }
        }
      }

      // Combine with default categories (which are not synced)
      const defaultCategories = localCategories.filter((c: any) => c.isDefault)
      merged.categories = [...defaultCategories, ...mergedCategories]
    }

    // Merge debt accounts (combine all, no loss)
    if (remoteData.debtAccounts && Array.isArray(remoteData.debtAccounts)) {
      const localDebtAccounts = localData.debtAccounts || []
      const remoteDebtAccounts = remoteData.debtAccounts

      const localMap = new Map(localDebtAccounts.map((d: any) => [d.id, d]))
      const mergedDebtAccounts = [...localDebtAccounts]

      for (const remote of remoteDebtAccounts) {
        if (!localMap.has(remote.id)) {
          mergedDebtAccounts.push(remote)
          mergeLog.push(`Added debt account: ${remote.name}`)
        } else {
          // For debt accounts, keep the one with the most recent activity
          const localVersion = localMap.get(remote.id)
          if (getTimestamp(remote) > getTimestamp(localVersion)) {
            const index = mergedDebtAccounts.findIndex((d: any) => d.id === remote.id)
            if (index !== -1) {
              mergedDebtAccounts[index] = remote
              mergeLog.push(`Updated debt account: ${remote.name}`)
            }
          }
        }
      }

      merged.debtAccounts = mergedDebtAccounts
    }

    // Merge credit accounts (combine all, no loss)
    if (remoteData.creditAccounts && Array.isArray(remoteData.creditAccounts)) {
      const localCreditAccounts = localData.creditAccounts || []
      const remoteCreditAccounts = remoteData.creditAccounts

      const localMap = new Map(localCreditAccounts.map((c: any) => [c.id, c]))
      const mergedCreditAccounts = [...localCreditAccounts]

      for (const remote of remoteCreditAccounts) {
        if (!localMap.has(remote.id)) {
          mergedCreditAccounts.push(remote)
          mergeLog.push(`Added credit account: ${remote.name}`)
        } else {
          // For credit accounts, keep the one with the most recent activity
          const localVersion = localMap.get(remote.id)
          if (getTimestamp(remote) > getTimestamp(localVersion)) {
            const index = mergedCreditAccounts.findIndex((c: any) => c.id === remote.id)
            if (index !== -1) {
              mergedCreditAccounts[index] = remote
              mergeLog.push(`Updated credit account: ${remote.name}`)
            }
          }
        }
      }

      merged.creditAccounts = mergedCreditAccounts
    }

    // Merge debt/credit transactions (combine all, no loss)
    if (remoteData.debtCreditTransactions && Array.isArray(remoteData.debtCreditTransactions)) {
      const localTransactions = localData.debtCreditTransactions || []
      const remoteTransactions = remoteData.debtCreditTransactions

      const localMap = new Map(localTransactions.map((t: any) => [t.id, t]))
      const mergedTransactions = [...localTransactions]

      for (const remote of remoteTransactions) {
        if (!localMap.has(remote.id)) {
          mergedTransactions.push(remote)
          mergeLog.push(`Added debt/credit transaction: ${remote.description}`)
        }
        // Note: We don't update existing transactions to avoid conflicts
        // Each transaction is unique and should only exist once
      }

      merged.debtCreditTransactions = mergedTransactions
    }

    // Handle emergency fund (keep higher value)
    if (remoteData.emergencyFund !== undefined) {
      const localFund = localData.emergencyFund || 0
      const remoteFund = remoteData.emergencyFund

      if (remoteFund > localFund) {
        merged.emergencyFund = remoteFund
        mergeLog.push(`Updated emergency fund: $${remoteFund} (was $${localFund})`)
      } else if (remoteFund < localFund) {
        mergeLog.push(`Kept local emergency fund: $${localFund} (remote had $${remoteFund})`)
      }
    }

    // Handle user profile (merge fields)
    if (remoteData.userProfile) {
      merged.userProfile = {
        ...localData.userProfile,
        ...remoteData.userProfile,
        // Keep the newer lastModified
        lastModified: Math.max(
          localData.userProfile?.lastModified || 0,
          remoteData.userProfile.lastModified || 0
        )
      }
      mergeLog.push(`Merged user profile settings`)
    }

    return { merged, conflicts, mergeLog }
  }

  // Sync data from Convex with smart conflict resolution
  const syncFromConvex = async (password?: string) => {
    if (!isAuthenticated || !user) {
      console.log('[syncFromConvex] Skipping - not authenticated')
      return { success: false, error: "User not authenticated" }
    }

    // If sync is not enabled, try to enable it first
    if (!syncState.isEnabled) {
      console.log('[syncFromConvex] Sync not enabled, attempting to enable...')
      const enableResult = await enableSync()
      if (!enableResult.success) {
        console.log('[syncFromConvex] Failed to enable sync:', enableResult.error)
        return { success: false, error: "Failed to enable sync" }
      }
      console.log('[syncFromConvex] Sync enabled successfully')
    }

    // Use provided password or generate one from user ID for consistency
    const syncPassword = password || `convex_sync_${user.id}_${user.email}`

    try {
      console.log('[syncFromConvex] Starting download...')
      setSyncState(prev => ({ ...prev, isSyncing: true, error: null }))

      // Get latest data from Convex
      const latestData = getLatestWalletData
      if (!latestData) {
        console.log('[syncFromConvex] No data in Convex yet - this is normal for first sync')
        setSyncState(prev => ({ ...prev, isSyncing: false }))
        return { success: true, message: "No remote data to sync" }
      }

      console.log('[syncFromConvex] Found remote data, decrypting...')

      // Decrypt data
      const remoteData = await decryptWalletData(latestData.encryptedData, syncPassword)

      console.log("Decrypted Convex data:", remoteData)

      // Prepare local data for comparison
      const localData = {
        userProfile,
        transactions,
        budgets,
        goals,
        debtAccounts,
        creditAccounts,
        debtCreditTransactions,
        categories,
        emergencyFund,
        exportedAt: Date.now(),
      }

      // Perform smart merge
      const { merged, conflicts, mergeLog } = mergeWalletData(localData, remoteData)
      // Import the merged data into the local wallet
      if (merged) {
        try {
          console.log('[syncFromConvex] Importing merged data...')
          // Use the importData function from the wallet data context
          const success = await importData(merged)

          if (success) {
            const now = Date.now()
            localStorage.setItem("convex_last_sync_time", now.toString())

            setSyncState(prev => ({
              ...prev,
              isSyncing: false,
              lastSyncTime: now,
            }))


            // Show detailed sync results
            if (mergeLog.length > 0) {
              toast({
                title: "Smart Sync Complete",
                description: `${mergeLog.length} changes merged successfully. No data lost!`,
              })

              // Log details for debugging
            } else {
            }

            return { success: true, data: merged, mergeLog, conflicts }
          } else {
            toast({
              title: "Sync Warning",
              description: "Data synced but some items may not have been imported.",
              variant: "default",
            })
            return { success: false, error: "Import failed" }
          }
        } catch (importError) {
          toast({
            title: "Sync Error",
            description: "Failed to import synced data. Please try again.",
            variant: "destructive",
          })
          return { success: false, error: "Import failed" }
        }
      }

      setSyncState(prev => ({ ...prev, isSyncing: false }))
      return { success: false, error: "Merge failed" }
    } catch (error: any) {
      console.error("[syncFromConvex] ❌ Download failed:", error)
      setSyncState(prev => ({
        ...prev,
        isSyncing: false,
        error: error.message || "Download failed",
      }))

      return { success: false, error: error.message || "Download failed" }
    }
  }

  // Get stored sync password
  const getSyncPassword = async (): Promise<string | null> => {
    try {
      const encryptedPassword = localStorage.getItem("convex_sync_password")
      const saltString = localStorage.getItem("convex_sync_salt")
      if (!encryptedPassword || !saltString) return null

      const salt = new Uint8Array(
        atob(saltString)
          .split("")
          .map((char) => char.charCodeAt(0))
      )
      const key = await SecureWallet.deriveKeyFromPin("convex_sync_key", salt)
      return await SecureWallet.decryptData(encryptedPassword, key)
    } catch (error) {
      console.error("Failed to decrypt sync password:", error)
      return null
    }
  }

  // SMART SYNC - PREVENTS DATA LOSS WITH INTELLIGENT MERGING
  useEffect(() => {
    if (!syncState.isEnabled || !isAuthenticated || syncState.isSyncing || syncState.isPaused) {
      console.log('[SYNC] Skipping - not enabled/authenticated/syncing/paused')
      return
    }

    console.log('[SYNC] 🚀 Data change detected, starting smart sync...')

    const performSmartSync = async () => {
      try {
        console.log('[SYNC] Starting smart sync cycle...')

        // Step 1: UPLOAD FIRST - Always upload current local data
        console.log('[SYNC] 📤 Step 1: Uploading current data to Convex...')
        const uploadResult = await syncToConvex()
        if (uploadResult.success) {
          console.log('[SYNC] ✅ Upload successful - local data saved to cloud')
        } else {
          console.error('[SYNC] ❌ Upload failed:', uploadResult.error)
          return // Don't download if upload failed
        }

        // Step 2: WAIT - Give Convex time to process the upload
        await new Promise(resolve => setTimeout(resolve, 500))

        // Step 3: DOWNLOAD WITH SMART CHECKS
        console.log('[SYNC] 📥 Step 2: Checking for remote updates...')

        // Only download if remote data is actually newer
        if (getLatestWalletData) {
          const lastSyncTime = localStorage.getItem("convex_last_sync_time")
          const remoteTime = getLatestWalletData.lastModified

          if (!lastSyncTime || (remoteTime && remoteTime > parseInt(lastSyncTime))) {
            console.log('[SYNC] 📡 Remote data is newer, downloading...')
            const downloadResult = await syncFromConvex()
            if (downloadResult.success) {
              console.log('[SYNC] ✅ Download successful - data merged intelligently')
            } else if (downloadResult.message) {
              console.log('[SYNC] ℹ️', downloadResult.message)
            } else {
              console.error('[SYNC] ❌ Download failed:', downloadResult.error)
            }
          } else {
            console.log('[SYNC] ✅ Local data is up to date - no download needed')
          }
        } else {
          console.log('[SYNC] No remote data available yet')
        }

        console.log('[SYNC] 🎉 Smart sync cycle completed successfully!')

      } catch (error) {
        console.error("[SYNC] 💥 Critical sync error:", error)
        setSyncState(prev => ({
          ...prev,
          error: error instanceof Error ? error.message : "Critical sync error"
        }))
      }
    }

    // Execute with smart delay to prevent excessive calls
    const timeoutId = setTimeout(performSmartSync, 1000) // 1 second delay

    return () => clearTimeout(timeoutId)
  }, [
    // Trigger on data changes, but exclude sync state to prevent loops
    // Use lengths instead of arrays to avoid reference changes causing useEffect warnings
    // Ensure all values are defined to prevent array size changes
    transactions?.length || 0,
    budgets?.length || 0,
    goals?.length || 0,
    debtAccounts?.length || 0,
    creditAccounts?.length || 0,
    debtCreditTransactions?.length || 0,
    categories?.length || 0,
    emergencyFund || 0,
    syncState.isEnabled,
    isAuthenticated,
    syncState.isPaused
    // Note: Removed syncState.isSyncing to prevent sync loops
    // Note: Removed userProfile to avoid TypeScript errors and unnecessary sync triggers
  ])

  // CONTINUOUS MONITORING - Check for remote changes every 10 seconds (respects pause state)
  useEffect(() => {
    if (!syncState.isEnabled || !isAuthenticated || syncState.isPaused) {
      return
    }

    const monitoringInterval = setInterval(async () => {
      try {
        if (syncState.isSyncing) {
          console.log('[SYNC] Skipping monitor - sync in progress')
          return
        }

        // Check if remote data is newer
        if (getLatestWalletData) {
          const lastSyncTime = localStorage.getItem("convex_last_sync_time")
          const remoteTime = getLatestWalletData.lastModified

          if (!lastSyncTime || (remoteTime && remoteTime > parseInt(lastSyncTime))) {
            console.log('[SYNC] 📡 Remote data is newer, downloading...')
            await syncFromConvex()
          } else {
            console.log('[SYNC] ✅ Local data is up to date')
          }
        } else {
          console.log('[SYNC] No remote data available yet')
        }
      } catch (error) {
        console.error("[SYNC] Monitoring error:", error)
      }
    }, 10000) // Check every 10 seconds

    return () => {
      console.log('[SYNC] 🛑 Stopping continuous monitoring')
      clearInterval(monitoringInterval)
    }
  }, [syncState.isEnabled, isAuthenticated, syncState.isSyncing, syncState.isPaused])

  // Pause auto sync
  const pauseSync = async () => {
    try {
      setSyncState(prev => ({ ...prev, isPaused: true }))
      localStorage.setItem("convex_sync_paused", "true")

      toast({
        title: "Auto Sync Paused",
        description: "Automatic sync is paused. You can still sync manually.",
      })

      return { success: true }
    } catch (error: any) {
      toast({
        title: "Error",
        description: "Failed to pause sync",
        variant: "destructive",
      })
      return { success: false, error: error.message }
    }
  }

  // Resume auto sync
  const resumeSync = async () => {
    try {
      setSyncState(prev => ({ ...prev, isPaused: false }))
      localStorage.removeItem("convex_sync_paused")

      toast({
        title: "Auto Sync Resumed",
        description: "Automatic sync is now active again.",
      })

      return { success: true }
    } catch (error: any) {
      toast({
        title: "Error",
        description: "Failed to resume sync",
        variant: "destructive",
      })
      return { success: false, error: error.message }
    }
  }

  // Load pause state from localStorage
  useEffect(() => {
    const isPaused = localStorage.getItem("convex_sync_paused") === "true"
    setSyncState(prev => ({ ...prev, isPaused }))
  }, [])

  return {
    ...syncState,
    enableSync,
    disableSync,
    pauseSync,
    resumeSync,
    syncToConvex,
    syncFromConvex,
    user,
    isAuthenticated,
  }
}
