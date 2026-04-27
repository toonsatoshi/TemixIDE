const getMainMenu = () => ({
  reply_markup: {
    keyboard: [
      [{ text: '📂 Forge' }, { text: '📂 Contract' }],
      [{ text: '📂 Workspace' }, { text: '📂 Account' }],
      [{ text: '📂 Sessions' }, { text: '✨ AI Forge' }]
    ],
    resize_keyboard: true,
    is_persistent: true
  },
  parse_mode: 'HTML'
});

module.exports = {
  getMainMenu
};
