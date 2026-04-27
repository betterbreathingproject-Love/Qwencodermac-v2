'use strict'

function register(ipcMain, { getCalibrationProfile, isCalibrating }) {
  ipcMain.handle('get-calibration', async () => {
    return getCalibrationProfile() || null
  })

  ipcMain.handle('calibration-status', async () => {
    const profile = getCalibrationProfile()
    return {
      status: isCalibrating() ? 'calibrating' : (profile ? 'ready' : 'unavailable'),
      profile: profile || null,
    }
  })
}

module.exports = { register }
