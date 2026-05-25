describe('ZenPanda — network interception', () => {
  it('intercepts and stubs a network request', () => {
    cy.intercept('GET', '**/api/data', { body: { result: 'stubbed' } }).as('apiData')

    // Visit a page that would normally call /api/data — we just verify intercept wiring
    cy.visit('https://example.com')
  })

  it('verifies cy.request works through ZenPanda', () => {
    cy.request('https://httpbin.org/get').then((response) => {
      expect(response.status).to.eq(200)
    })
  })
})
