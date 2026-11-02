import type { Scenario } from '@nowait-qa/sdk'
import { byId, byText, open, tap } from './helpers/android.ts'

export default {
  id: 'app.alert-dialog',
  platforms: ['android'],
  async run(driver) {
    await open(driver, 'App', 'Alert Dialogs', 'OK Cancel dialog with a message')
    await driver.$(byId('android:id/alertTitle')).waitForDisplayed()
    await tap(driver, byId('android:id/button1')) // OK
    await driver.$(byText('OK Cancel dialog with a message')).waitForDisplayed()
  },
} satisfies Scenario
