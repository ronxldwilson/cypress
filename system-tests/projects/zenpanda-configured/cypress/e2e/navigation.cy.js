describe('ZenPanda — navigation', () => {
  it('loads a page and reads the title', () => {
    cy.visit('https://example.com')
    cy.title().should('include', 'Example')
  })

  it('navigates back and forward', () => {
    cy.visit('https://example.com')
    cy.visit('https://example.com/404') // any second URL
    cy.go('back')
    cy.url().should('include', 'example.com')
  })
})
