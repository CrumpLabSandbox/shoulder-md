import { mount } from 'svelte';
import './fonts.css';
import './styles/app.css';
import App from './ui/App.svelte';

const target = document.getElementById('app');
if (!target) throw new Error('Missing #app mount point');

export default mount(App, { target });
