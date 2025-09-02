interface SessionData {
  id: string
  createdAt: number
  lastActivity: number
  expiresAt: number
}

export class SessionManager {
  private static readonly SESSION_COOKIE = 'wallet_session'
  private static readonly SESSION_TIMEOUT = 5 * 60 * 1000 // 5 minutes
  private static readonly COOKIE_MAX_AGE = 24 * 60 * 60 // 24 hours

  private static activityTimer: NodeJS.Timeout | null = null

  /**
   * Create a new session after successful PIN authentication
   */
  static createSession(): void {
    const sessionId = this.generateSessionId()
    const now = Date.now()

    const sessionData: SessionData = {
      id: sessionId,
      createdAt: now,
      lastActivity: now,
      expiresAt: now + this.SESSION_TIMEOUT
    }

    console.log('[SessionManager] Creating session:', sessionData)

    // Store session data in cookie
    this.setSessionCookie(sessionData)

    // Start activity tracking
    this.startActivityTracking()

    console.log('[SessionManager] Session created successfully:', sessionId)
  }

  /**
   * Validate current session without extending it
   */
  static isSessionValid(): boolean {
    const sessionData = this.getSessionData()

    if (!sessionData) {
      return false
    }

    const now = Date.now()

    // Check if session has expired due to inactivity
    if (now > sessionData.expiresAt) {
      this.clearSession()
      return false
    }

    return true
  }

  /**
   * Validate and extend current session (for user activity)
   */
  static validateAndExtendSession(): boolean {
    const sessionData = this.getSessionData()

    if (!sessionData) {
      return false
    }

    const now = Date.now()

    // Check if session has expired due to inactivity
    if (now > sessionData.expiresAt) {
      this.clearSession()
      return false
    }

    // Update last activity and extend session
    sessionData.lastActivity = now
    sessionData.expiresAt = now + this.SESSION_TIMEOUT
    this.setSessionCookie(sessionData)

    return true
  }

  /**
   * Clear current session
   */
  static clearSession(): void {
    // Clear cookie
    document.cookie = `${this.SESSION_COOKIE}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;`

    // Stop activity tracking
    this.stopActivityTracking()

    console.log('[SessionManager] Session cleared')
  }

  /**
   * Get session data from cookie
   */
  private static getSessionData(): SessionData | null {
    try {
      const cookies = document.cookie.split(';')
      console.log('[SessionManager] All cookies:', cookies)

      const sessionCookie = cookies.find(cookie =>
        cookie.trim().startsWith(`${this.SESSION_COOKIE}=`)
      )

      console.log('[SessionManager] Session cookie found:', !!sessionCookie)

      if (!sessionCookie) {
        return null
      }

      const sessionValue = sessionCookie.split('=')[1]
      const decodedData = decodeURIComponent(sessionValue)
      const parsedData = JSON.parse(decodedData)

      console.log('[SessionManager] Parsed session data:', parsedData)
      return parsedData
    } catch (error) {
      console.error('[SessionManager] Error parsing session data:', error)
      return null
    }
  }

  /**
   * Set session data in cookie
   */
  private static setSessionCookie(sessionData: SessionData): void {
    const encodedData = encodeURIComponent(JSON.stringify(sessionData))
    const expires = new Date(Date.now() + this.COOKIE_MAX_AGE * 1000)

    document.cookie = `${this.SESSION_COOKIE}=${encodedData}; expires=${expires.toUTCString()}; path=/; SameSite=Strict; Secure`
  }

  /**
   * Generate a unique session ID
   */
  private static generateSessionId(): string {
    const array = new Uint8Array(16)
    crypto.getRandomValues(array)
    return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('')
  }

  /**
   * Start tracking user activity to extend session
   */
  private static startActivityTracking(): void {
    this.stopActivityTracking() // Clear any existing timer

    // Track various user activities
    const activities = ['mousedown', 'mousemove', 'keypress', 'scroll', 'touchstart', 'click']

    const activityHandler = () => {
      // Extend session on user activity
      this.validateAndExtendSession()
    }

    activities.forEach(event => {
      document.addEventListener(event, activityHandler, { passive: true })
    })

    // Store handler reference for cleanup
    ;(window as any).__walletActivityHandler = activityHandler

    // Set up periodic session validation
    this.activityTimer = setInterval(() => {
      const sessionStatus = this.getSessionStatus()
      console.log('[SessionManager] Periodic check:', sessionStatus)

      if (!this.isSessionValid()) {
        console.log('[SessionManager] Session expired due to inactivity')
        // Session expired, trigger PIN screen
        this.handleSessionExpiry()
      }
    }, 2000) // Check every 2 seconds for faster response
  }

  /**
   * Stop activity tracking
   */
  private static stopActivityTracking(): void {
    if (this.activityTimer) {
      clearInterval(this.activityTimer)
      this.activityTimer = null
    }

    // Remove activity listeners
    const activityHandler = (window as any).__walletActivityHandler
    if (activityHandler) {
      const activities = ['mousedown', 'mousemove', 'keypress', 'scroll', 'touchstart', 'click']
      activities.forEach(event => {
        document.removeEventListener(event, activityHandler)
      })
      delete (window as any).__walletActivityHandler
    }
  }


  /**
   * Handle session expiry
   */
  private static handleSessionExpiry(): void {
    console.log('[SessionManager] Handling session expiry')
    this.clearSession()

    // Dispatch custom event to notify app of session expiry
    const event = new CustomEvent('wallet-session-expired')
    window.dispatchEvent(event)
    console.log('[SessionManager] Session expiry event dispatched')
  }

  /**
   * Get session status for debugging
   */
  static getSessionStatus(): {
    isValid: boolean
    timeRemaining: number
    lastActivity: number
  } | null {
    const sessionData = this.getSessionData()

    if (!sessionData) {
      return null
    }

    const now = Date.now()
    const isValid = now <= sessionData.expiresAt

    return {
      isValid,
      timeRemaining: Math.max(0, sessionData.expiresAt - now),
      lastActivity: sessionData.lastActivity
    }
  }
}