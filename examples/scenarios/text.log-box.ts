import type { Scenario } from '@nowait-qa/sdk'
import { byId, byText, open, tap } from './helpers/android.ts'

export default {
  id: 'text.log-box',
  platforms: ['android'],
  async run(driver) {
    await open(driver, 'Text', 'LogTextBox')
    await tap(driver, byText('Add'))
    const box = driver.$(byId('io.appium.android.apis:id/text'))
    await driver.waitUntil(async () => (await box.getText()).includes('This is a test'), {
      timeoutMsg: 'the log box never showed the added line',
    })
  },
} satisfies Scenario
