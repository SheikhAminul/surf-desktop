// The message for the state the desktop app is in (it navigates here with #starting, #stopping or #updating).
const MESSAGES = {
	starting: 'Starting Browsy…',
	stopping: 'Saving open profiles and closing…',
	updating: 'Installing the update…',
}
const show = () => {
	document.getElementById('state').textContent = MESSAGES[location.hash.slice(1)] ?? MESSAGES.starting
}
addEventListener('hashchange', show)
show()
