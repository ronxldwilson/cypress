describe('ZenPanda — DOM interaction', () => {
  it('finds elements by selector', () => {
    cy.visit('https://example.com')
    cy.get('h1').should('exist')
    cy.get('p').should('have.length.at.least', 1)
  })

  it('reads element text content', () => {
    cy.visit('https://example.com')
    cy.get('h1').invoke('text').should('not.be.empty')
  })

  it('executes arbitrary JavaScript', () => {
    cy.visit('https://example.com')
    cy.window().then((win) => {
      expect(win.document.title).to.be.a('string')
    })
  })
})
