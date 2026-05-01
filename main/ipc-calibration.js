'use strict'

const calibrator = require('../calibrator')

function register(ipcMain, { getCalibrationProfile, isCalibrating, setCalibrationProfile }) {
  ipcMain.handle('get-calibration', async () => {
    return getCalibrationProfile() || null
  })

  ipcMain.handle('calibration-status', async () => {
    const profile = getCalibrationProfile()
    return {
      status: isCalibrating() ? 'calibrating' : (profile ? 'ready' : 'unavailable'),
      profile: profile || null,
      modes: calibrator.MODES,
    }
  })

  // Switch calibration mode — recomputes profile from cached metrics
  ipcMain.handle('calibration-set-mode', async (_, mode) => {
    const profile = getCalibrationProfile()
    if (!profile || !profile.metrics) return { error: 'No calibration data available' }
    if (!calibrator.MODES[mode]) return { error: `Invalid mode: ${mode}. Use: ${Object.keys(calibrator.MODES).join(', ')}` }
    const newProfile = calibrator.computeProfile(profile.metrics, mode)
    newProfile.fromCache = true
    if (setCalibrationProfile) setCalibrationProfile(newProfile)
    return newProfile
  })
}

module.exports = { register }
