import { byId, open } from './helpers/android.ts'
import type { Scenario } from './index.ts'

export default {
  id: 'views.text-field',
  platforms: ['android'],
  async run(driver) {
    await open(driver, 'Views', 'Controls', '1. Light Theme')
    const field = driver.$(byId('io.appium.android.apis:id/edit'))
    await field.waitForDisplayed()
    await field.setValue('nowait-qa')
    const value = await field.getText()
    if (value !== 'nowait-qa') throw new Error(`text field shows "${value}"`)
  },
} satisfies Scenario
